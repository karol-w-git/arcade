# Deploying Arcade

One small Google Cloud VM, HTTPS via Caddy, code pulled from GitHub.
Sized for a handful of players: an `e2-micro` in a US free-tier region costs
nothing, and the game itself runs in the browser, so the server only serves pages
and records scores — latency to the US is irrelevant.

Run these on **your machine** unless a step says otherwise.

---

## 1. Push the repo to GitHub

```bash
cd A:\ClaudeCodeProjects\arcade; gh repo create arcade --public --source=. --remote=origin --push
```

Public keeps the VM step to one command. Nothing sensitive is committed — `data/`
(database, session key, sprites) is gitignored, and the only vendored file is
three.js under its MIT licence.

*Prefer private?* Use `--private`, then on the VM generate a key with
`ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519`, and add the public half with
`gh repo deploy-key add ~/.ssh/id_ed25519.pub --repo karol-w-git/arcade`. Clone
via the `git@github.com:` URL instead.

## 2. Create the VM

Reserve the IP first (or promote it afterwards, as done here) so the hostname
never changes — a stopped VM otherwise comes back with a different address:

```bash
gcloud compute addresses create arcade-ip --project=arcade-games-kw --region=us-central1
```


```bash
gcloud compute instances create arcade --project=arcade-games-kw --zone=us-central1-a --machine-type=e2-micro --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=30GB --boot-disk-type=pd-standard --tags=http-server,https-server
```

`us-central1` + `e2-micro` + 30 GB standard disk is what the always-free tier
covers. A European region would be about $7/month for the same box; the game runs
in the browser, so the extra latency to the US is not noticeable.

The arcade lives in its own project (`arcade-games-kw`, display name "Arcade"),
separate from anything else you run. The free-tier VM allowance is per *billing
account*, not per project, so this does not use up an allowance twice.

Open the web ports, if the project doesn't already have these rules:

```bash
gcloud compute firewall-rules create allow-http --allow=tcp:80 --target-tags=http-server --project=arcade-games-kw
```

```bash
gcloud compute firewall-rules create allow-https --allow=tcp:443 --target-tags=https-server --project=arcade-games-kw
```

## 3. Pick the hostname

```bash
gcloud compute instances describe arcade --zone=us-central1-a --project=arcade-games-kw --format="value(networkInterfaces[0].accessConfigs[0].natIP)"
```

Take that IP, swap the dots for dashes, and append `.nip.io` — this deployment's
`35.188.197.255` became **`35-188-197-255.nip.io`**. That hostname resolves to your VM
with no DNS setup, and Caddy will get a real certificate for it, so the padlock
works and the player password isn't sent in the clear.

Own a domain? Point an `A` record at the IP and use that instead — the app never
needs to know its own hostname, so you can switch later by re-running step 4.

## 4. Install everything

The VM clones the deploy scripts from GitHub itself - no file copying, and it
works regardless of what your local network allows.

> **If your network blocks outbound port 22** (mine does), add
> `--tunnel-through-iap` to every `ssh`/`scp` command. It routes SSH through
> Google over 443. It needs the IAP API and a firewall rule for Google's tunnel
> range - both created once:
>
> ```bash
> gcloud services enable iap.googleapis.com --project=arcade-games-kw
> ```
>
> ```bash
> gcloud compute firewall-rules create allow-ssh-iap --project=arcade-games-kw "--allow=tcp:22" "--source-ranges=35.235.240.0/20"
> ```
>
> `gcloud compute scp` is best avoided on Windows either way: it shells out to
> PuTTY's `pscp`, which cannot resolve `~` as a destination.

> **PowerShell quoting:** the `gcloud` wrapper re-splits arguments containing
> double quotes, so a remote command with quotes in it arrives mangled. Pass the
> command as a variable, and if it needs quotes, base64-encode it:
>
> ```powershell
> $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
> $c = "echo $b64 | base64 -d | sudo bash"
> gcloud compute ssh arcade --zone=us-central1-a --project=arcade-games-kw --tunnel-through-iap --quiet --command $c
> ```
>
> Comma-separated flag values need quoting too: `"--tags=http-server,https-server"`.

```powershell
$script = @'
set -euo pipefail
apt-get update -qq
apt-get install -y -qq git
rm -rf /tmp/arcade-boot
git clone -q --depth 1 https://github.com/karol-w-git/arcade.git /tmp/arcade-boot
bash /tmp/arcade-boot/deploy/setup-vm.sh https://github.com/karol-w-git/arcade.git 35-188-197-255.nip.io
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
gcloud compute ssh arcade --zone=us-central1-a --project=arcade-games-kw --tunnel-through-iap --quiet --command "echo $b64 | base64 -d | sudo bash"
```

Substitute your own hostname. The script installs Python, git, sqlite3 and Caddy,
creates an unprivileged `arcade` user, clones the repo, builds a virtualenv,
generates the admin password and session key into `/etc/arcade.env` (mode 600),
and starts the service behind Caddy.

**It prints the generated dashboard password once. Save it.** After that it lives
only in `/etc/arcade.env`.

Then open `https://<your-host>` and sign in.

## 5. Move your existing instances up (optional)

The VM starts with an empty database. Either rebuild your instances through the
dashboard, or copy the local ones up **once**:

Send it through a private bucket. (Base64 over the SSH command line works only
for tiny files - Windows caps a command line at ~32 KB, and a 44 KB database is
already 60 KB encoded.)

```bash
gcloud storage buckets create gs://arcade-backups-kw --project=arcade-games-kw --location=us-central1 --uniform-bucket-level-access
```

```bash
gcloud storage cp data/arcade.db gs://arcade-backups-kw/restore/arcade.db --project=arcade-games-kw
```

Let the VM's service account read it, then pull it down and swap it in:

```bash
gcloud storage buckets add-iam-policy-binding gs://arcade-backups-kw "--member=serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" "--role=roles/storage.objectViewer" --project=arcade-games-kw
```

```powershell
$c = "gcloud storage cp gs://arcade-backups-kw/restore/arcade.db /tmp/arcade.db && sudo systemctl stop arcade && sudo cp /tmp/arcade.db /opt/arcade/app/data/arcade.db && sudo chown arcade:arcade /opt/arcade/app/data/arcade.db && sudo systemctl start arcade"
gcloud compute ssh arcade --zone=us-central1-a --project=arcade-games-kw --tunnel-through-iap --quiet --command $c
```

Delete the copy afterwards - it contains password hashes:

```bash
gcloud storage rm gs://arcade-backups-kw/restore/arcade.db --project=arcade-games-kw
```

Sprites travel the same way, as a tar of `data/uploads`.

After this, **treat the VM as the source of truth** — it accumulates real scores
you cannot recreate. Copy down, never up.

## 6. The iterate loop

Work locally with auto-reload:

```bash
cd A:\ClaudeCodeProjects\arcade; $env:ARCADE_DEBUG = "1"; python app.py
```

Ship when you're happy:

```bash
git add -A; git commit -m "what changed"; git push
```

```powershell
$c = "cd /opt/arcade/app && sudo git pull -q && sudo chown -R arcade:arcade /opt/arcade/app && sudo systemctl restart arcade && sleep 3 && systemctl is-active arcade"
gcloud compute ssh arcade --zone=us-central1-a --project=arcade-games-kw --tunnel-through-iap --quiet --command $c
```

> The first pull fails with *"dubious ownership"* - root pulling a checkout owned
> by the `arcade` user. `setup-vm.sh` now marks the path safe; on a box installed
> before that, run once:
> `sudo git config --global --add safe.directory /opt/arcade/app`

Re-running `setup-vm.sh` does the same thing plus dependency updates, and leaves
`data/` and the secrets untouched. After the first install, run it from the
checkout so you always get the current version of the script:

```bash
gcloud compute ssh arcade --zone=us-central1-a --project=arcade-games-kw --tunnel-through-iap --quiet --command="sudo bash /opt/arcade/app/deploy/setup-vm.sh https://github.com/karol-w-git/arcade.git 35-188-197-255.nip.io"
```

## 7. Backups (worth doing once players exist)

```bash
gcloud storage buckets create gs://arcade-backups-kw --location=us-central1 --project=arcade-games-kw
```

```bash
gcloud compute ssh arcade --zone=us-central1-a --project=arcade-games-kw --tunnel-through-iap --quiet --command="sudo bash ~/deploy/backup.sh gs://arcade-backups-kw"
```

Nightly at 03:00, via root's crontab on the VM:

```
0 3 * * * bash /home/YOUR_USER/deploy/backup.sh gs://arcade-backups-kw >> /var/log/arcade-backup.log 2>&1
```

The VM's service account needs write access to the bucket — grant it with
`roles/storage.objectCreator` if the first run is denied.

## Operating it

| | |
| --- | --- |
| Logs | `sudo journalctl -u arcade -f` |
| Restart | `sudo systemctl restart arcade` |
| Status | `systemctl status arcade caddy` |
| Change admin password | edit `/etc/arcade.env`, then restart |
| TLS problems | `sudo journalctl -u caddy -n 50` |
| Stop paying | `gcloud compute instances delete arcade --zone=us-central1-a` |

The service runs as an unprivileged user under systemd hardening — read-only
filesystem apart from `data/`, no new privileges, private `/tmp` — and restarts
itself on failure or reboot.
