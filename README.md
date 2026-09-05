# Topic Timer

A personal desktop timer that tracks how much time you spend on named topics. It runs as a small borderless widget on your desktop background — not a normal window.

## How it works

- **Start** a Session by typing a free-text Topic name (matched case-insensitively, whitespace trimmed).
- **Pause** finalizes the current Session and logs the elapsed time, then offers Resume; the topic stays locked until you Stop.
- **Resume** starts a new Session on the same Topic, continuing the clock from the paused total.
- **Stop** ends the Session and permanently writes it to the log. A stopped Session cannot be resumed.
- A **Cap** of 12 hours finalizes the Session automatically with a notice; you can Resume to start a new one.

Consecutive Sessions on the same Topic form a Work Block in the log.

The log is stored as `log.json` in `%APPDATA%\TopicTimer` by default. Open the widget's gear icon to pick a different folder — the choice is remembered and your history is carried over and merged if the target folder already has a log.

## Dashboard

A read-only summary of your topic log lives in `dashboard/` and is automatically published to GitHub Pages on every push to `main`.

## Download

Grab the latest build for your platform from [Releases](https://github.com/KRISHNATEJATATA/timer-app/releases):

| Platform | File |
|----------|------|
| Windows | `topic-timer-*-win_x64.zip` |
| macOS | `topic-timer-*-mac_universal.zip` |
| Linux | `topic-timer-*-linux_x64.tar.gz` |

Each archive contains the platform binary plus `resources.neu`; keep both files together and run the binary.

## Development

Requires Node.js and the Neutralino CLI:

```sh
npm install
npm run update   # fetch Neutralino binaries into bin/
npm run dev      # run the widget locally
npm test         # core, app, and dashboard tests
npm run build    # build all platform binaries into dist/
```

## Releasing

Push a tag to trigger the release workflow, which tests, builds all platforms, and publishes the archives:

```sh
git tag v1.0.1
git push origin v1.0.1
```

## License

[MIT](LICENSE)
