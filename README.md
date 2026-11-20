# Study Studio

Study Studio is a small classroom app for creating revision quizzes and flashcards. A teacher runs the server. Students open its web app, enter an access code, and create projects containing one or more study apps. Saved apps can be downloaded as HTML files and used offline.

## Student setup

Open the link your teacher gives you and enter your student code. The website works in a normal tab. Use **Install app** if the button appears. On iPad or iPhone, open the link in Safari and choose **Share → Add to Home Screen**. On other devices, look for **Install** or **Add to Home screen** in the browser menu.

The public [installation page](https://gowanginc.github.io/study-studio/) provides a student kit and a sample quiz. Your teacher provides the link for your class.

## Teacher quick start

Install [Node.js](https://nodejs.org/) 22.13 or later. Open this repository folder in a terminal and run:

```sh
npm start
```

Open the address printed in the terminal, normally `http://127.0.0.1:8765`. Enter the teacher code printed there. Open a session, create a code for `Student 1`, and try the student code in a separate browser profile. Demo requests use sample solar-system content.

### Live model

```sh
npm run setup:harness
npm run start:live
```

The server uses DeepSeek V4.1 Flash through OpenCode Go. Put a valid OpenCode Go API key in a private file on the teacher's machine and set `OPENCODE_GO_KEY_FILE` to its path. The app looks for `opencode-go.key` under `$XDG_CONFIG_HOME/study-studio` or `~/.config/study-studio` if the variable is unset. It can also use `OPENCODE_GO_API_KEY` or a local OpenCode Go sign-in. Keep credentials and student data outside the checkout. Students use only their access codes.

### Connect student devices

The Node process listens on loopback. For a classroom, put a trusted HTTPS reverse proxy on the same host and use an HTTPS address reachable from student devices. For example, set `STUDY_ORIGIN=https://studio.example.org` and have the proxy preserve that host when forwarding to `http://127.0.0.1:8765`. Students open the HTTPS address. The proxy's certificate must be trusted on their devices. Test this from an actual student network before the first session.

Projects are stored on the server under `~/.local/share/study-studio` by default. Use a separate `STUDY_DATA_DIR` for each group. Codes and sign-ins expire when the server restarts. Reissuing a code for the same student label in the same data directory restores that label’s projects. Keep labels assigned to the same students.

Close the session to stop new AI requests, cancel active turns, and expire unsaved drafts. Saved apps remain available. The teacher view records project and app activity, blocked requests, and generation failures. It does not retain chat transcripts. Explain the monitoring to students and check your institution's provider, moderation, and data-handling requirements before classroom use.

## How it works

A patched [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) profile receives one turn at a time and has no model-facing shell or file tools. The server relays bounded requests to [OpenCode Go](https://opencode.ai/docs/console/go/), validates the returned quiz or flashcard data, and renders it using fixed HTML and JavaScript. The builder requires the teacher's server. Downloaded quizzes and flashcards run offline on their own.
