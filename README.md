# PhotoFlix (hospital waiting-room screen)

A TV in a hospital waiting area that loops photos (health tips, notices, camp posters) with the time and weather, and **calls patients by token number** on screen and by voice, so the nurse does not have to shout names.

## What it does

**TV (Fire TV app or any browser at `/tv/`)**
* Full-screen loop of photos **and videos** in the order staff choose, with clock, date and weather. Videos play to the end (sound optional in Settings) and pause while a token is announced. Wide photos fill the screen; tall ones, and banners much wider than a TV, are shown whole over a blurred copy.
* When the PhotoFlix PC restarts and its free Cloudflare link changes, the TV (like the staff phones) finds the new link by itself and keeps its screen code; the Fire TV app remembers it for the next power-on.
* When a nurse calls a patient: a big red card "Token 12, Ravi Kumar, please go to Room 2", a chime, and a voice announcement said twice (Recall on the phone says it again). The voice is made by **Amazon Polly** (Indian English, "Kajal") and played by the TV as a sound file, because Fire TV sticks have no voice of their own for apps. The server's AWS user needs the `polly:SynthesizeSpeech` permission (the AWS policy **AmazonPollyReadOnlyAccess** includes it); without it the TV falls back to its own voice, if it has one. A room typed as just a number ("2") is shown and said as "Room 2".
* Never shows phone numbers. Patient names can be hidden (Settings → Show patient names on TV).
* First time: a big QR code to set up the screen. Once staff have joined, the QR is hidden and only shows on request: **OK** on the remote (or phone Settings → Show QR on TV). **Back** hides it again; if nobody does, it hides itself after a few minutes.

**Staff phone (scan the TV's QR, opens in the browser, nothing to install, works on any network)**
* **Patients tab:** add a patient (name, optional mobile; the token number is automatic), **Call next**, Recall, see today's list (All / Waiting / Done), tap a patient to edit name/mobile, Call, Done, Skip or Delete.
* **Photos tab:** add photos and videos (many at once; photos are shrunk on the phone just enough to fill a full-HD TV, videos up to 300 MB are shrunk to 1080p on the server; both fill the whole TV screen), change their number in the loop, delete. Videos go up in 8 MB parts, 3 at a time, straight from the phone to S3 (signed links; without a bucket, 2 MB parts through the server); a part that fails is sent again, so a weak connection slows an upload down instead of breaking it.
* **⚙️ Settings:** screen name (optional), city for the weather, my room/counter, photo speed, voice on/off, show names on/off, show QR on TV, change staff PIN, start new day, unlink.
* The first phone on a new screen **chooses** the staff PIN (typed twice; the join page says "Choose a staff PIN"). Every other phone must **enter** that PIN. Patients can see the QR but cannot change anything.

Tokens start from 1 every day (midnight, India time).

## How it is built

```
Staff phone (QR link) ─WebSocket─▶ PhotoFlix server (Node.js) ─Invoke─▶ AWS Lambda "patientopd" ─▶ DynamoDB
        ▲                               │      │                                                  (PhotoFlixScreensTable,
        └──────── live updates ─────────┤      └─▶ S3: photos + screen settings                     PhotoFlixPatientsTable)
                                        └──▶ TV (Kotlin Fire TV app / browser): slideshow, weather, token calls + voice
```

| Part | Technology |
|---|---|
| Server | Node.js, Express, WebSocket (`server/`) |
| Staff phone page | Mobile web page (`public/phone/`) |
| TV screen | Web page (`public/tv/`) inside a Kotlin Fire TV app (`firetv/`) that adds Android text-to-speech, sound without a button press, screen always on, start after power-on |
| Patient queue | AWS Lambda + DynamoDB (`PF_LAMBDA`), with a 36-hour TTL so names and mobiles delete themselves |
| Photos + settings | Amazon S3 (`PF_BUCKET`) |
| Weather | Open-Meteo (free, no key) |
| Phones on any network | Cloudflare Tunnel, opened automatically by `npm start` |

## Run it

```bash
npm install
npm start
```

* Open the TV screen address it prints on the Fire TV app (Menu button = change address) or a browser.
* Scan the QR with a staff phone, enter a name and choose a PIN.
* In a browser (not the app), press **OK / click once** so sound is allowed.

`.env` settings:

| Setting | Meaning |
|---|---|
| `PF_BUCKET` | S3 bucket for photos and screen settings (empty = local `data/` folder) |
| `PF_LAMBDA` | Lambda name for the patient queue, e.g. `patientopd` (empty = queue kept in this server) |
| `PUBLIC_URL` | Fixed public address for the QR (empty = free Cloudflare link, changes on restart) |
| `TUNNEL=off` | Do not open the Cloudflare link |

AWS login comes from `aws configure`. That user needs S3 access to the bucket and `lambda:InvokeFunction` on the Lambda; the Lambda's role needs DynamoDB access to both tables.

## Fire TV app

```bash
cd firetv
gradlew assembleDebug -PserverUrl=http://192.168.0.164:3200
```
The APK is `firetv/app/build/outputs/apk/debug/app-debug.apk` (needs Java 17 and the Android SDK). Install it with `adb install`, or type the server address on the TV the first time.

## Screens and sound

Every token call plays a chime and then a recording of the sentence, made by the server with Amazon Polly (Indian English voice "Kajal"; the AWS user needs `polly:SynthesizeSpeech`). A sound file plays the same on every screen, so announcements do not depend on the TV having a speech engine. If the recording cannot be made (no internet, no Polly permission, `PF_SPEECH=off`), the screen uses its own voice.

| Screen | How to set it up | Sound starts |
|---|---|---|
| Fire TV, Android TV / Google TV | the PhotoFlix app (`firetv/`) | by itself |
| Monitor on a Windows PC or mini-PC | double-click `tv-screen-kiosk.bat` (another PC: `tv-screen-kiosk.bat http://<server-ip>:3200/tv/`); for power-on, put a shortcut in `shell:startup` | by itself |
| Monitor on a Raspberry Pi / Linux | `chromium-browser --kiosk --autoplay-policy=no-user-gesture-required http://<server-ip>:3200/tv/` | by itself |
| Smart-TV browser (Samsung, LG) or any other browser | open `http://<server-ip>:3200/tv/` | after OK / one click, each time the page opens |

The screen needs working speakers: the TV's own, or for a monitor, HDMI audio to its speakers or external speakers.

## Files

| Path | What it is |
|---|---|
| `server/index.js` | Web server, QR codes, `/api/info` |
| `server/screens.js` | Screens, photos, staff PIN, queue actions, WebSocket |
| `server/queue-lambda.js` | Calls the patient-queue Lambda |
| `server/store.js` | S3 / local storage (and optional DynamoDB for screen settings) |
| `server/tunnel.js` | Cloudflare link for phones on any network |
| `server/video.js` | Shrinks videos to 1080p H.264 with ffmpeg (ffmpeg-static) |
| `public/tv/` | TV screen |
| `public/tv/img/fan-*` | Example pictures and clips on the TV before any photo is added (free from Pexels: [beach waves](https://www.pexels.com/video/sunset-beach-ocean-waves-3058522/), [mountain lake](https://www.pexels.com/video/the-sun-sets-over-a-lake-and-mountains-20605896/), [maple leaves](https://www.pexels.com/photo/vibrant-red-maple-leaves-in-autumn-sunshine-34942439/), [golden retriever](https://www.pexels.com/photo/golden-retriever-dog-resting-on-grassy-meadow-7932804/), [misty valley](https://www.pexels.com/photo/a-sunrise-over-a-valley-with-fog-and-hills-16672664/)) |
| `public/phone/` | Staff phone page |
| `firetv/` | Kotlin Fire TV app |
| `lambda/` | AWS Lambda `patientopd` for the patient queue (DynamoDB). Deploy `index.mjs` in the AWS console (Node.js 22.x); setup and permissions in `lambda/README.md`; `node lambda/_localtest.mjs` tests it offline |
| `tv-screen-kiosk.bat` | Opens the TV screen full screen on a Windows monitor, sound allowed |

## License

MIT, see [LICENSE](LICENSE).

Note: "PhotoFlix" is also the name of an existing product (myphotoflix.com). Rename this app before showing it publicly.
