# `ddn`: discordrive-next from the command line

`ddn` uploads, downloads and manages the files of an account from scripts and terminals. It signs in
with an **API key** and encrypts and decrypts on the computer it runs on, like any device of the
account: the server never gets a key it could use. It works with instances in every mode
(metadata only, e2ee, plain); the mode is read from the instance.

## API keys

Create one in the app: **Settings → Account & security → API keys → Create key**. The key
(`ddn-api1:…`) is shown once: copy it or download the file.

- A key gives **full access to the files of the account** except the Safe. The server cannot limit it
  to a folder. Keep it like a password.
- A key is a device of the account (it is on the Devices list as "API key"). Revoke it there or in
  API keys; `ddn` then stops with exit code 5. Whoever copied the key could already read the files
  (see `docs/threat-model.md`, §2.4).

## Setup

From the repository (Node.js 22.13 or newer):

```sh
npm ci
node apps/cli/bin/ddn.mjs login --key-file ~/discordrive-api-key.txt
node apps/cli/bin/ddn.mjs whoami
```

(`npm link -w @ddv4/cli` puts `ddn` on the PATH.) `ddn login` without `--key-file` reads the key from
standard input. The downloaded file can be given as it is (the key line is found in it).

The key is stored in the profile folder, owner-only: `~/.config/ddn/<profile>/` (Linux, macOS; also
`$XDG_CONFIG_HOME/ddn`), `%APPDATA%\ddn\<profile>\` (Windows), or `$DDN_CONFIG_DIR`. `--profile NAME`
(or `DDN_PROFILE`) keeps several keys apart; the default profile is `default`. The folder also holds the
account's file list (so a command does not fetch it again) and the resume points of unfinished uploads.

Without storing the key (containers, CI): set `DDN_API_KEY` (the text) or `DDN_API_KEY_FILE` (a file
with it). The key is then kept in memory only; the file list and resume points go to
`<config>/ddn/env-<device ID>/`.

`ddn logout` forgets the key on this computer (it keeps working elsewhere until revoked).

## Commands

Paths are those of the Drive in the app (`/Photos/2024/a.jpg`); `--gallery` uses the Gallery instead.
A node ID (32 hex characters, as printed by `--json`) works wherever a path does.

| Command | What it does |
|---|---|
| `ddn whoami` | server, mode, account, device, channels, files and space used |
| `ddn ls [PATH] [-l]` | list a folder (default `/`); `-l` with sizes and dates |
| `ddn stat PATH` | one file (size, date, SHA-256) or folder (counts) |
| `ddn put SRC… DEST` | upload files and folders (folders recursively). DEST: an existing folder, or a path ending in `/` (made with `--parents`), or a new name for one file |
| `ddn get PATH [DEST]` | download a file (into DEST, a folder or a file name; default the current folder; `-` = standard output). `-r` for a folder |
| `ddn mkdir [-p] PATH` | make a folder (`-p`: with its parents, no error if it exists) |
| `ddn mv SRC… DEST` | move into a folder, or rename one item (`ddn mv /a.txt /b/c.txt`) |
| `ddn rm PATH…` | move to the trash (30 days, restore in the app). `--permanent` deletes for good: asks, or `--yes` |
| `ddn find TEXT` | search names (and descriptions where the account has them) |
| `ddn version` | the build |

`put --on-conflict`: `rename` (default, like the app: `name (2).ext`), `replace` (a new version of the
file of that name) or `skip`. An interrupted upload of the same file to the same folder continues where
it stopped (run the same `put` again). Downloads are written to `<name>.ddnpart` and renamed when the
whole file's SHA-256 matched.

Progress goes to standard error (on a terminal); `--quiet` / `-q` turns it off.

## Output for scripts: `--json`

One JSON object per line on standard output. Fields are only ever added, not renamed or removed.

- `ls`: `{"id","name","kind":"file"|"folder","size","modifiedAt","path"}` per entry (`size`/`modifiedAt`
  null for folders; times in ms since 1970, UTC).
- `stat`: the same plus `sha256`, `trashed`; folders `folders`, `files`, `bytes`.
- `put`: `{"event":"uploaded","source","id","path","size","sha256","skipped","replaced","resumedPieces"}`
  per file, `{"event":"failed","source","error"}` for a file that failed.
- `get`: `{"event":"downloaded","id","path","target","size","sha256"}`, or `failed`.
- `mv`: `{"event":"moved","id","path","outcome"}`; `rm`: `{"event":"trashed"|"deleted","id","path"}`.
- `mkdir`: `{"id","path","created"}`; `find`: `{"id","name","kind","size","path"}`.
- `whoami`: `{"server","mode","accountId","deviceId","channels","canUpload","files","bytes","version"}`.
- `login`: `{"ok":true,"server","mode","accountId","deviceId","profile"}`.
- On an error: `{"error","exit"}` (and the message on standard error).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | failed (e.g. some files of a `put` did not go; the others did) |
| 2 | usage (unknown command or option, missing argument, `rm --permanent` not confirmed) |
| 3 | no such file or folder (`find`: nothing found) |
| 4 | network or server error (try again) |
| 5 | the key was refused: not signed in, damaged, revoked, or the account is blocked |
| 6 | no channel to upload to (add one in the app), or a rate limit |

## Examples

```sh
# Nightly backup of a folder, skipping files already there
ddn put --parents --on-conflict skip ~/Documents /Backup/laptop/ -q

# What is in a folder, as data
ddn ls /Backup/laptop --json | jq -r 'select(.kind=="file") | .path'

# A file to standard output
ddn get /notes/todo.txt - | grep -i urgent
```
