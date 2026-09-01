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

```bash
gcloud compute instances create arcade --project=warsaw-caterpillars --zone=us-central1-a --machine-type=e2-micro --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=30GB --boot-disk-type=pd-standard --tags=http-server,https-server
```

`us-central1` + `e2-micro` + 30 GB standard disk is what the always-free tier
covers. `europe-central2` (where warsaw-transport lives) would be about $7/month
for the same box.

Open the web ports, if the project doesn't already have these rules:

```bash
gcloud compute firewall-rules create allow-http --allow=tcp:80 --target-tags=http-server --project=warsaw-caterpillars
```

```bash
gcloud compute firewall-rules create allow-https --allow=tcp:443 --target-tags=https-server --project=warsaw-caterpillars
```

## 3. Pick the hostname

```bash
gcloud compute instances describe arcade --zone=us-central1-a --project=warsaw-caterpillars --format="value(networkInterfaces[0].accessConfigs[0].natIP)"
```

Take that IP, swap the dots for dashes, and append `.nip.io` — an IP of
`34.71.2.9` becomes **`34-71-2-9.nip.io`**. That hostname resolves to your VM
with no DNS setup, and Caddy will get a real certificate for it, so the padlock
works and the player password isn't sent in the clear.

Own a domain? Point an `A` record at the IP and use that instead — the app never
needs to know its own hostname, so you can switch later by re-running step 4.

## 4. Install everything

```bash
gcloud compute scp --recurse deploy arcade:~ --zone=us-central1-a --project=warsaw-caterpillars
```

```bash
gcloud compute ssh arcade --zone=us-central1-a --project=warsaw-caterpillars --command="sudo bash ~/deploy/setup-vm.sh https://github.com/karol-w-git/arcade.git 34-71-2-9.nip.io"
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

```bash
gcloud compute scp --recurse data/arcade.db data/uploads arcade:/tmp/ --zone=us-central1-a --project=warsaw-caterpillars
```

```bash
gcloud compute ssh arcade --zone=us-central1-a --project=warsaw-caterpillars --command="sudo systemctl stop arcade && sudo cp /tmp/arcade.db /opt/arcade/app/data/ && sudo cp -r /tmp/uploads /opt/arcade/app/data/ && sudo chown -R arcade:arcade /opt/arcade/app/data && sudo systemctl start arcade"
```

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

```bash
gcloud compute ssh arcade --zone=us-central1-a --project=warsaw-caterpillars --command="cd /opt/arcade/app && sudo git pull && sudo systemctl restart arcade"
```

Re-running `setup-vm.sh` does the same thing plus dependency updates, and leaves
`data/` and the secrets untouched. After the first install, run it from the
checkout so you always get the current version of the script:

```bash
gcloud compute ssh arcade --zone=us-central1-a --project=warsaw-caterpillars --command="sudo bash /opt/arcade/app/deploy/setup-vm.sh https://github.com/karol-w-git/arcade.git 34-71-2-9.nip.io"
```

## 7. Backups (worth doing once players exist)

```bash
gcloud storage buckets create gs://arcade-backups-warsaw --location=us-central1 --project=warsaw-caterpillars
```

```bash
gcloud compute ssh arcade --zone=us-central1-a --project=warsaw-caterpillars --command="sudo bash ~/deploy/backup.sh gs://arcade-backups-warsaw"
```

Nightly at 03:00, via root's crontab on the VM:

```
0 3 * * * bash /home/YOUR_USER/deploy/backup.sh gs://arcade-backups-warsaw >> /var/log/arcade-backup.log 2>&1
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
