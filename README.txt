TwinGaze - hidden camera finder
Team Ragnarok - iQOO Hackathon 2026, Hyderabad City Battle (26-27 Sept 2026)
Anshul Nautiyal (team lead) - Prathibha Rani Patra - Sourab Reddy

WHAT THIS IS
An Android app (and the same app as a website) that finds cameras with the phone's own
hardware. Everything runs on the phone; nothing is uploaded. No demo mode, no simulated data:
every reading on screen is live, or - for a recorded video - read from that recording.

It finds cameras four ways at once:
  1. It RECOGNISES cameras by their shape: a small neural network trained for this app
     (CCTV, dome, bullet, PTZ, security cameras). Works with the lights on - this is what
     finds the CCTV camera on the ceiling.
  2. It catches the GLINT of a hidden lens: the flash bounces straight back off a camera
     lens, like a cat's eye. Every frame is searched for tiny, sharp points of light, and
     each one is tested (below). This finds pinhole cameras that don't look like cameras.
  3. It LISTENS with the magnetometer: powered electronics bend the magnetic field. The
     beeper speeds up and the dial's needle climbs as you get closer ("Device detected" past
     +25 µT). It reads the field three ways, best first, and shows which one it is using:
       - phone magnetometer   (the APK reads the sensor directly)
       - Chrome magnetometer  (website, with the experimental-web-platform flag on)
       - compass method       (website, no flag needed): Chrome's compass-based orientation is
         compared with its gyroscope-only orientation. They agree until something bends the
         field; the swing of the compass heading gives an approximate µT (38 × tan(swing)).
  4. It sees NIGHT-VISION lights: in the dark, the infrared LEDs of night-vision cameras
     show up to the phone camera as small purple dots (Night-vision scan).

It also TELLS YOU WHAT IS IN THE ROOM: a second on-phone model names people and ~50 kinds of
room objects (clock, TV, picture frame, mirror, lamp, bulb, socket, switchboard, fan, soft
toy, plant, smoke detector...). The "In view" panel lists them; the voice points out the
ones cameras hide in ("Clock ahead. Cameras hide in things like this, check it."); "What's
here?" reads out everything in view; and a hiding spot you scan with the flash is ticked off
the room checklist automatically ("Checked the clock: no lens found").

THE AGENT (Full room scan)
A Coordinator agent runs the scan as a plan and hands work to specialist agents that share one
memory of the room. Every decision and every tool it runs is shown live (the Agent card on the
scan screen, the Agent trace panel on a laptop) and goes into the report.
  Plan:  Prepare -> Radio (in the background) -> Survey -> Inspect -> Report
  Environment  reads the light (lux / camera brightness), the flash, the magnetometer and the
               orientation sensor, and picks the strategy (lit room: lean on the shape
               recogniser and go close; dark room: glints show from across the room).
  Radio        (app only) Wi-Fi scan for camera hotspots and camera-maker radios, Bluetooth scan
               for AirTag / Tile / SmartTag trackers, network scan of the Wi-Fi you joined for
               camera ports (RTSP 554, ONVIF, Dahua 37777, XMEye 34567).
  Coverage     maps which directions you have swept (12 x 30° with the phone's orientation
               sensor) and whether you looked at the ceiling. Shown as the mini radar.
  Scene        remembers every hiding spot the object recogniser names (clock, frame, smoke
               detector, socket...) with the direction it was seen in.
  Glint        remembers bright points that never got a verdict, so you are walked back to them.
  Magnetic     marks every jump of the magnetic field with the direction you faced.
  Navigator    turns the memory into directions: "Turn right 60°, to the clock", then "Move
               left" until it is in the circle, then "Hold the flash on it for three seconds".
  Report       weighs everything into a risk level (High / Check again / Low) with the reasons.
The agents are rules, not a chatbot: deterministic, instant, offline. A glint or a camera in view
always takes over from the Navigator; once a camera is reported the plan carries on, so a second
camera isn't missed, and the same camera seen again after turning round is recognised, not
re-reported.

ALL THE TOOLS (Home -> Quick tools, or the Tools tab)
  Full room scan    the agent runs everything above
  Lens finder       flash + camera glint tests, you steer
  Night vision      lights off, flash off: infrared LEDs of night cameras
  Magnetic          the beeping detector with the dial
  Wi-Fi scan        camera hotspots (HD-xxxx, IPCAM, V380...) and camera makers' radios   (app)
  Bluetooth         AirTags / Tile / SmartTag trackers and Bluetooth cameras               (app)
  Network           cameras on the Wi-Fi you joined: RTSP / ONVIF / DVR ports             (app)
  Mirror test       fingernail, flashlight (camera + flash) and knock tests for two-way mirrors
  Recorded video    frame-by-frame analysis of a room video
  Phone check       spyware and stalkerware on this phone, with one-tap uninstall          (app)
  SOS               call 112 / 181 / 1930, or text your location to your trusted contact
Also: History of every scan (on the phone only), Evidence locker, Settings with voice language,
Discreet mode (dim, silent, guidance by vibration), Sensitivity (Sensitive / Balanced / Strict),
Trusted contact, live Sensors status, and a first-run "How it works".

PHONE CHECK (spyware / stalkerware on the phone itself, APK only)
  Home -> Phone check. Reads every installed app and a few security settings, on the phone:
  - Known stalkerware: package names and signing certificates from "Stalkerware Indicators of
    Compromise" by Echap (CC BY 4.0), 131 stalkerware + 27 monitoring apps, bundled in
    js/spyware-db.js (tools/update-spyware-db.mjs refreshes it). A renamed copy of a listed app
    is caught by its certificate.
  - Behaviour: no app icon, installed from outside an app store, accessibility service on (reads
    the screen, taps for you), device admin (blocks uninstalling), notification access (reads
    messages), a name dressed up as a system app, access to camera / mic / location / SMS.
  - Settings: screen lock, security-patch age, USB debugging, developer options, root signs.
  - Camera & microphone right now: whether any app is using a camera or recording audio at this
    moment (Android's camera service / active recordings), and every app allowed to use them.
  "Uninstall" opens Android's own uninstall dialog (Android never lets an app remove another app
  silently); device-admin apps are sent to the device-admin screen first. "It's mine" marks an
  app as trusted. It is not a full antivirus: a clean result means none of these signs were found.

PHONES USED AS HIDDEN CAMERAS
  A phone left on a shelf or in a washroom records like any spy camera. The camera recogniser
  has a third class, "phone" (the object recogniser also names phones), so:
  - a phone in view is announced ("A phone is in view. Phones can record video...") and becomes
    the agent's top-priority spot to inspect;
  - its lens gets the same flash + angle tests as any glint; a confirmed lens on a phone raises
    "Phone camera found" (evidence kind "phone camera", in the complaint too);
  - a phone that was seen but never checked makes the verdict "Check again".
  If it is your own phone reflected in a mirror, tap it on the screen to ignore it.

HOW A GLINT IS TESTED
  1. Flash test   - the app switches the flash off and on. A lens (a reflection) goes dark
                    with it. A lamp, LED or screen keeps shining -> ruled out as a light.
  2. Sideways     - you slide the phone left and right keeping it in the circle. What counts
                    is how much the point's direction in the room changes (orientation sensor
                    + where it sits in the picture): turning on the spot changes nothing, only
                    real sideways movement does. It needs 6° with the flash (8° without): about
                    a hand's width each way at 1 m. Pointing straight up or down, where the
                    direction can't be read, it falls back to how far the phone turned.
                    (Before 2.3 this used the gyroscope's turn, so turning on the spot passed
                    shiny reflections: the main cause of false "camera found".)
  3. Stays on its object - the textured surface around the point is followed frame by frame
                    (block matching on the analysed picture). A lens sits in its object and
                    moves with it. A reflection on something shiny (glossy table, tiles, glass,
                    a screen) is wherever the surface faces the flash, so it slides across the
                    surface as you move -> ruled out as a reflection.
  4. Flash test again after moving - still the same reflection, not a different point.
  5. Magnetic     - bring the phone close; +8 µT or more at the spot = electronics behind it.
"Camera found" needs tests 1-2 (score 0.72+) AND a second, independent sign: a magnetic jump at
the spot, a camera shape, or a device with a camera recognised there: a phone ("Phone camera
found"), a tablet or a camera anywhere on it, a laptop or monitor only in its top bezel where
the webcam sits ("Laptop camera found"). A glint alone
can't tell a lens from a tiny shiny bead or screw head, so without a second sign the point is
saved as a "POSSIBLE LENS" (orange) with its photo, for you to look at closely. Night-vision
scan keeps its own rule (purple infrared tint + angle).
A point that goes through every test and doesn't qualify is marked "not a camera".
Lights on is fine: in a lit room the camera exposure is turned right down so a glint still
stands out (it shows from 1-2 m; in the dark it shows from across the room).

THE CAMERA RECOGNISER (how it was made, for the judges)
  - 2.6: upgraded from YOLO11n to YOLO11s, trained on the laptop's GPU (RTX 5050, 100 epochs) with
    the real false alarms from the hackathon hall added as hard negatives (a desk cable hole, a laptop
    screen reflection, a glossy sticker, a stage wall). Same held-out photos, never seen in training:
      cameras (18 with, 33 without)   YOLO11n: 12 found / 2 false at 50%,  7 found / 1 false at 70%
                                      YOLO11s: 12 found / 0 false at 50%, 12 found / 0 false at 70%
      phones (19 with, 87 without)    YOLO11n: 12 found / 1 false at 50%
                                      YOLO11s: 12 found / 4 false at 50% (remote-like look-alikes)
    YOLO11s is far more sure of real cameras (83-93% where YOLO11n gave 57-60%), so a shape alone
    confirms a camera from 70%; from 50% the zoomed full-resolution look must agree twice.
  - Model: YOLO11s (9.4 M parameters, 36 MB; was YOLO11n, 2.6 M), runs on the phone through ONNX Runtime
    (GPU via WebGPU when available, CPU otherwise). A detection only counts after it shows
    up in 3 of the last 6 looks that could see it, at 50%+, so one odd frame never raises an
    alarm. Guesses from 40% are drawn as a dashed orange "POSSIBLE CAMERA" box.
  - Zoomed looks: the checks take turns - whole picture, middle half (2x), whole picture, middle
    quarter (4x). The zoomed looks cut the middle out of the camera's full-resolution frame, so a
    small or far camera you point at gets 2-4x the pixels. Anything camera-like from 30% makes
    the guide say "Hold on it" (for at most 4 s in the middle) so the zoomed looks can decide.
    Test (camera photos pasted small into room photos, 720x1280 frames, 32 cameras, found at
    50%+): camera 140 px tall - whole picture 3, with the zoomed looks 12; 220 px - 4 vs 14.
    Camera-free frames with a camera box >= 50%: 1 of 50 for each look (a smoke detector).
  - Training photos: ~1,100 freely licensed photos from Wikimedia Commons: CCTV / security
    cameras, plus rooms, ceilings, lamps, sprinklers, speakers and ~170 smoke detectors.
  - Labels: two large open-vocabulary detectors (Google OWLv2 and Grounding DINO) had to
    agree on every camera box. Smoke detectors got their own class, so the model learns
    that a round white ceiling device is not automatically a camera.
  - Three classes: camera, smoke detector, phone. Phone photos: 306 from Commons (206 kept where
    both teachers agreed, 388 phone boxes) plus 238 look-alikes (remotes, calculators, power banks,
    camera batteries, walkie-talkies...) so it learns what is not a phone.
  - Held-out test (photos it never saw):
      cameras: 13 of 18 found with 2 false alarms out of 33 at the alarm level (0.40);
               15 of 18 at the candidate level (0.20), shown as "CAMERA?" boxes
      phones:  14 of 19 found with 1 false alarm out of 87 (1 of 18 look-alikes)
    Off-the-shelf zero-shot models found 4 of 18 cameras with 5 false alarms; the stock
    Open Images model found 8 of 19 phones with 6 false alarms.
  - Room objects: YOLOv8n trained on Open Images V7 (Ultralytics), 49 relevant classes kept.

THE ANDROID APP (APK)
  dist/TwinGaze.apk - install it on the phone:
    - over USB:  adb install -r dist/TwinGaze.apk
    - or send the file to the phone (WhatsApp / Drive / Office Kit) and open it
      (allow "install unknown apps" for that app once).
  In the app the magnetometer, light sensor, voice (Android text-to-speech), vibration and
  keep-screen-on are native: no Chrome flags needed.
  Evidence photos go to Pictures/TwinGaze, recordings to Movies/TwinGaze, reports to
  Download/TwinGaze.

  Rebuilding the APK (needs Node 22+, JDK 21, Android SDK 36):
    cd android-app
    npm install
    node ../tools/build-web.mjs && npx cap sync android
    cd android && gradlew assembleDebug        (JAVA_HOME = a JDK 21)
  The native code is android-app/android/app/src/main/java/in/teamragnarok/twingaze/:
  TwinNativePlugin.java (sensors incl. orientation, voice, vibration, gallery, share sheet,
  clipboard), TwinRadioPlugin.java (Wi-Fi, Bluetooth LE and network scans) and
  TwinGuardPlugin.java (installed apps, security settings, uninstall / settings shortcuts).
  Permissions it asks for when used: Camera; Location + Nearby Wi-Fi (Wi-Fi scan);
  Bluetooth Scan/Connect (Bluetooth scan); Location (SOS map link).

OFFICE KIT (vivo / iQOO phone <-> laptop)
  - Report -> "Send report to laptop · Office Kit": saves the whole report (photos, SHA-256
    fingerprints, complaint) as one HTML file in Download/TwinGaze and opens the share
    sheet; pick Office Kit to drop it on the paired laptop. It opens in any browser.
  - Evidence photos are saved to the TwinGaze album, which Office Kit syncs to the laptop.
  - "Copy text" puts the complaint on the shared clipboard: paste it on the laptop.
  - For the demo, mirror the phone on the laptop screen with Office Kit.

THE WEBSITE VERSION
  node tools/build-web.mjs site   -> drag the site/ folder onto Netlify (Deploys page).
  Chrome needs https for the camera. The magnetic detector works in plain Chrome through the
  compass method; for the direct magnetometer reading turn on
  chrome://flags/#enable-experimental-web-platform-features. The APK needs neither.
  Fonts are bundled (vendor/fonts), so nothing waits on the network, in the app or on the site.
  Local testing over Wi-Fi: node tools/serve.mjs (prints an https address for the phone).

USING IT
  1. Pick the room, tap "Start full room scan" (or the round scan button). Follow the voice:
     turn slowly all the way round, look up at the ceiling, then go where the agent sends you.
  2. Boxes: red frame = camera recognised by shape; brackets = glints being tested;
     dashed = room objects (yellow = a hiding spot, green tick = checked, blue = person).
  3. Follow the voice ("move left", "hold still", "step sideways"). On "Camera found!"
     the phone vibrates and saves a photo with its SHA-256 fingerprint.
  4. Finish -> report: evidence, objects recognised, places checked, a complaint in English
     or Hindi (BNS 2023 s.77, IT Act s.66E, 1930), and "Send report to laptop".
  Voice: English, हिंदी, తెలుగు (Settings). Magnetic detector, radio scans, mirror test: Tools.

DEMO SCRIPT (hackathon)
  0. Full room scan: tap Start. The Agent card shows the plan; turn slowly round - the radar
     fills in, hiding spots are remembered, then "Turn right 60°, to the clock". On a laptop the
     Agent trace panel shows every decision (mirror the phone with Office Kit).
  1. Live, lights on: point the phone at the hall's CCTV camera. The shape recogniser boxes
     it and says "Camera found" - that's the lit-room case.
  2. Hidden camera: a spy camera in a clock / charger / frame. "In view" names the object
     and tells you to check it; the glint tests confirm the lens; the magnetic beeper speeds
     up as you bring the phone close.
  3. Recorded video: Record a scan in the room beforehand (Record button). "Analyse a
     recorded room video" replays it with the sensor readings saved with it (on the same
     phone): flash tests, gyroscope and magnetic µT replay in sync, labelled as recorded.
  4. Report -> Send report to laptop · Office Kit; open it on the laptop.

NETWORK CHECK (2.7, in the app)
  Is the Wi-Fi you were given private? Read from Android (no test traffic is sent):
  - protection: open / WEP / old WPA / WPA2 / WPA3 (Android's security type, or the scan's capabilities)
  - evil twin: another network with the same name but no password (or you are on the open copy)
  - a sign-in (captive) page, no internet, an HTTP proxy set on the Wi-Fi (someone in the middle)
  - who sees your browsing: VPN on? Private DNS on (host or automatic)? If neither, the Wi-Fi owner
    can log every site name you visit: the check says how to turn Private DNS on (dns.google).
  - devices on the Wi-Fi: every address that answers (even "port closed"), the name the router gives
    it (reverse DNS), UPnP descriptions (router, TV, printer, camera + maker/model) and ONVIF cameras.
  Open it from Detectors → Network check. It also runs inside the full room scan's radio step.

APP TRACKERS (2.7, in Phone check)
  Every downloaded app's code (classes*.dex in its APK, readable by any app) is searched in one pass
  (a byte trie) for the published Java package names of ~60 tracking / advertising SDKs: session replay
  (Smartlook, UXCam, Clarity: records the screen), location-data SDKs (Foursquare, Cuebiq, Huq...),
  profiling / attribution (AppsFlyer, Adjust, Branch, Meta App Events, CleverTap, MoEngage...), ad
  networks, analytics and crash reporting. Each app is shown with what it can also reach (location,
  camera, microphone, contacts, SMS) and the companies that reach the most apps are listed.

SEVERAL CAMERAS IN ONE VIEW (3.2)
  Tested on a WhatsApp video of the hackathon hall (464x832: WhatsApp shrinks videos) with two CCTV
  domes on the ceiling. 3.1 found the near dome in under a second but not the far one: at that size the
  far dome is ~12 px in the model's picture (seen in 3 of 95 frames). Now:
  - videos under 960 px also get the 2x zoomed look (the middle half): the far dome is seen in 80 of 95
    frames, up to 79%; nothing else in the hall passes 41%. The phone's own camera (720x1280 and up)
    keeps the 2x + 4x looks as before.
  - two cameras on screen at the same time are two cameras. Before, a camera found within 18 degrees
    (live) or 3 s (video) of another counted as the same one, and these domes are ~12 degrees apart.
  - a small box that jitters is matched by distance when there is no direction to match it by, a second
    box on the same object in one look is merged, and a camera found at the same spot in a video within
    12 s is the same camera (it was counted twice).
  Result on the hall video: both domes, within ~2 s, in 5 of 5 runs; no false cameras.
  Labels no longer sit under the header: a camera's label goes below its box there.
  The hall video ships with the app as a reference (media/hall-reference.mp4): Detectors → Video →
  "Hackathon hall · reference". It is analysed like any other video (no stored results, nothing
  staged); only at the end is the count compared with what the hall has (2 CCTV domes), shown as
  "Reference check" in the report and the log.
  3.2.2: one tap from Home ("Watch it find cameras · reference video", under Scan room / Check phone);
  "Play the reference video again" on the report keeps the reference check (it was lost on replay);
  the report is headed "Reference video · Hackathon hall". The scan view is calmer: points being weighed
  keep their yellow brackets but no score labels (the one being tested says CHECKING), and the frame-rate
  chip only shows with ?debug.

SMOOTHNESS (3.2.3)
  Measured in Chrome with the CPU slowed 4x (to act like a mid-range phone), reference video:
    32 -> 53 frames a second, frames over 50 ms 29 -> 8, long tasks 31 -> 8 (2.3 s -> 0.8 s),
    main thread busy 94% -> 70%. Detection unchanged: still 2 of 2 cameras at 4x slower.
  - The overlay (boxes, brackets, arrows) has its own loop at the screen's rate, and every box eases
    to where the latest analysis put it (~70 ms) instead of jumping between checks.
  - Adaptive pacing: the next frame is analysed after max(30 ms, 2.2 x the time the last one took),
    up to 90 ms. Fast phones analyse as before (~33 a second); a slow phone keeps about half of each
    second free for the screen, the voice and taps.
  - The scan log no longer lays the page out for every line (it scrolls once per screen frame).
  - Screens fade in (0.18 s, opacity only), a new instruction fades in, the tab bar's nearly
    invisible blur is gone (it re-blurred the page on every scroll frame), and the Hindi / Telugu fonts
    load while the app is idle so Settings opens without a hitch.

SHAKE FOR SOS INSIDE THE APP (3.2.4)
  Shaking the phone hard 3 times (over 2.6 g, within 1.6 s) anywhere in TwinGaze opens the SOS sheet,
  also during a scan (a scan's slow moves stay far below 2.6 g). It was added in 2.8 and lost when Home
  was reverted; only the background service (Protection outside the app) still reacted to a shake.
  Not while the fake call or siren screen is up. Tested: gentle movement and two jolts do nothing.

BUG FIXES AND PLAIN WORDING (3.2.3)
  A review of the whole app (scan and report logic, the Android layer, and all visible text) found:
  - A lens found again after stepping sideways was sometimes reported twice: "found here before" now
    allows 18 degrees (stepping sideways moves a lens's direction by up to ~17 degrees), unless the earlier
    find is on screen at the same time somewhere else, which means two cameras.
  - The survey's 90 s limit counted time spent testing bright spots, so a busy room could end the survey
    with part of the room never looked at. Testing and "Camera found" time no longer count (4 min cap).
  - The reference video counted as a room scan: Home showed "Camera found" and SOS texts said "2 cameras
    found in Hackathon hall" for 12 hours. It is now its own kind ("Reference video") in History.
  - Network check "Fix" buttons (Wi-Fi settings, Private DNS) never opened anything.
  - A recorded video after a Night-vision scan was analysed as night vision.
  - Mirror test: Back while the camera opened left the camera and flash on; a double tap skipped a step.
  - A fake call or the siren ending let the screen sleep in the middle of a scan.
  - Stopping a scan during a flash test left the magnetometer's drift tracking off; the light sensor
    was never stopped; "Change voice" spoke while Discreet mode stayed on; a photo still being saved when
    a video ended was missing from its report; Stop during a video's first moment left a ghost scan;
    Back from a History entry skipped History; the browser fake call was silent.
  Android: a fake call or SOS countdown now holds a timed wake lock (timers stopped while the phone
  slept); Android 7-10 gets a fresh SOS location (it used only the last known one); a dual-SIM phone with
  no default SMS SIM sends through the default SMS, else calling, SIM; the network scan can read device
  descriptions (plain http on the local Wi-Fi); protection comes back after a restart; "Allow Autostart"
  opens Xiaomi / vivo / OPPO's own list; a stuck "in progress" notification after a restart is gone.
  Wording: no "AI", "agent", "neural network" or sparkle icon on the screens; the Room check card shows
  what happened in plain words (no internal names, no code-like lines); no point numbers or decimal
  scores on the main screens; "Camera found" everywhere (the voice said "detected").

VOICE (3.0)
  Written like a navigation voice: short, calm, "<what happened>. <what to do>." in English, Hindi and
  Telugu (formal forms), no exclamation marks, the same words for the same thing every time
  ("Camera detected. Do not touch it." · "Reflection only. Continue scanning.").
  One speaker at a time (js/voice.js), with four levels:
    urgent  - camera / possible lens / device detected, camera blocked: may cut in;
    event   - results and steps ("Not a camera", "Scan started"): wait for the current line;
    routine - directions the guide repeats: spoken only once they have held 0.45 s, so a direction
              that flips back and forth is never read out; repeated at most every 4.5 s;
    info    - "Clock ahead", "Phone detected": only after 4 s of quiet.
  0.55 s of silence between lines; a line that could not be said in time is dropped, never said late.
  "Camera detected" is said once per camera (then at most every 15 s while it stays on screen).
  On the phone: the best installed offline voice for the language (highest quality, the Indian
  regional voice first), rate 0.95, spoken on the navigation audio channel so music is lowered, and the
  app is told the moment a sentence ends (no guessing, no cut-offs). tests/voice.test.js checks the rules.
  Simulated busy hall: ~20 lines a minute, never two at once (before: ~25 with overlaps and repeats).

PROTECTION OUTSIDE THE APP (2.9)
  Settings → Safety → "Protection outside the app" (one switch). It asks for notifications, location
  and SMS, then runs a foreground service (Android shows its notification: that is the rule for apps
  that keep working in the background). While it runs, with TwinGaze closed:
  - SOS: press the power button 3 times within 3 s (works with the screen off and the phone locked;
    ignored during phone calls, when the proximity sensor flips the screen), or shake the phone hard
    (3 jolts over 2.6 g within 1.6 s) while the screen is on. With the screen off Android stops the
    motion sensor unless an app keeps the phone awake, which drains the battery, so the power button
    is the trigger for a phone in a pocket. Also: the "SOS" button on the notification, and an "SOS"
    tile in Quick Settings (Settings → Add SOS tile uses Android's own "add tile" dialog).
    Then: 5-second countdown with strong vibration and a Cancel button → a fresh location fix (8 s max,
    else the last one from the past 10 minutes) → an SMS to the trusted contact with a map link and
    anything TwinGaze found recently. Without the SMS permission, a notification opens the text ready to
    send. The last notification has "Call 112". "Test SOS" runs everything but sends nothing.
  - Fake call: from the notification, or the SOS sheet with a delay: the service rings the phone's own
    ringtone with an incoming-call notification, so it rings even with the phone locked; Answer opens
    TwinGaze's call screen.
  - Privacy alerts: the camera or microphone used while the screen is off (stalkerware records then and
    Android's green/orange dot is invisible; calls are ignored); a known stalkerware app installed
    (package or signing certificate from the bundled list) or a new app with no icon asking for
    location, microphone, SMS, camera or screen reading; joining an open or WEP Wi-Fi, or one with a proxy.
  vivo and other makers stop background apps to save battery: "Keep it running" asks Android to leave
  TwinGaze alone. Protection comes back on by itself the next time TwinGaze is opened.

SOS SHEET (2.8)
  The SOS button (top right on Home) opens: Call 112 · Share my location · Fake call · Siren ·
  Call 181 · Call 1930. Share my location texts your trusted contact a map link plus what TwinGaze
  found in the last 12 h (camera, spyware, unsafe Wi-Fi); the SMS app opens filled in and you press
  send. Fake call: the phone's own ringtone and a real-looking call screen (now, 10 s, 30 s, 1 min),
  so you have a reason to leave. Siren: a loud alarm on the alarm audio channel (your volume setting
  is not touched) with the flash blinking. Home is unchanged: nothing extra was added there.

STEADY INSTRUCTIONS (2.6)
  A busy hall (lamps, laptops, glossy desks) gives hundreds of bright points a minute. The guide now
  steers only to a point in the central half of the picture that has lasted 8+ frames, keeps it until it
  is resolved, holds routine directions on screen for 1.2 s (no left/up flip-flop on a diagonal), and
  spaces flash tests 1.5 s apart with at most 2 unclear tries per point. "It's centred, hold still" and
  results always show at once. In the simulated busy hall: 56 instruction changes a minute -> 20.
  "Camera sees nothing" is said when the lens is covered or the phone lies on its back, and a scan left
  in the background says so when it resumes (Android gives no camera frames to a hidden app).

WHAT IT CAN'T DO (say this before a judge asks)
  - It can miss a camera that is covered, pointed away, or behind tinted plastic.
    "No camera found" lowers the risk; it doesn't rule it out.
  - The shape recogniser finds cameras that look like cameras. A pinhole camera inside a
    clock looks like a clock: that's what the glint and magnetic tests are for.
  - Mirrors, glass and TV screens reflect the flash like a lens when faced squarely; the
    sideways and stays-on-its-object tests rule them out once you slide the phone.
  - A camera across a big hall (a CCTV dome 5 m away is ~30 px in the picture) is at the limit
    of the shape recogniser even with the 4x look: walk closer and point at it.
  - A tiny shiny curved thing (a bead, a screw head, a drop of water) can pass every light
    test: that is why it is only a "possible lens" until a magnetic jump or a camera shape
    confirms it.
  - Smoke detectors are sometimes confused with dome cameras (1 in 8 in the test photos).
  - A recording without its saved sensor readings has no gyroscope, so its angle test is
    weaker than a live scan's.
  - Radio scans need the APK (browsers can't scan). Android allows about 4 Wi-Fi scans per
    2 minutes, needs Location switched on for Wi-Fi results, and hides iBeacon/Eddystone
    beacons from apps like this. Many cameras record to a memory card and never use Wi-Fi:
    a clean radio scan lowers the risk, it doesn't rule a camera out.
  - Turn angles come from the orientation sensor, which drifts a few degrees a minute; once
    the target is in the picture the agent steers by the picture instead.

FILES
  index.html, css/, js/        the app (same code in the APK and on the website)
    js/detector.js             glint detector + tracker
    js/recognizer.js           on-phone neural networks (ONNX Runtime Web)
    js/sensors.js              camera + flash, gyroscope, magnetometer, light, wake lock
    js/native.js               bridge to the Android plugin (in the APK)
    js/agent.js                the agent: Coordinator + specialist agents, coverage radar
    js/radio.js                Wi-Fi / Bluetooth / network scans and their camera classifiers
    js/guard.js, spyware-db.js phone check: classifier + known-stalkerware list (Echap, CC BY 4.0)
    js/audio.js, js/voice.js   beeper; voice in English / Hindi / Telugu
    js/app.js                  scan loop, scoring, guidance, objects, evidence, report
  models/                      camera-detector.onnx (trained for TwinGaze), objects.onnx
  vendor/ort/                  ONNX Runtime Web 1.30 (MIT licence)
  android-app/                 the Capacitor Android project
  dist/TwinGaze.apk            the built app
  tools/                       build-web.mjs, serve.mjs
  tests/                       node tests/detector.test.js · node tests/agent.test.js ·
                               node tests/radio.test.js · node tests/guard.test.js

DESIGN
  After vivo Office Kit: off-white page, white cards, black type, coral red (#EE3A4F) and warm
  yellow (#FDCF58) as the only accents, flat colours, black pill buttons, red/yellow triangles.
  Plus Jakarta Sans (bundled, OFL). The Android launch screen (res/values/styles.xml,
  Theme.SplashScreen) shows the same mark on the same background as the in-app animation.
  App icon: adaptive vector (res/drawable/ic_launcher_*.xml) with a themed monochrome layer.
  Status bar: dark icons on light screens, light icons over the camera (SystemBars).

PERFORMANCE
  Both neural networks run in a Web Worker (js/infer-worker.js): the camera frame goes over as a
  small ImageBitmap, the worker letterboxes it and runs the model (WebGPU when the phone has it,
  else WebAssembly), and only the boxes come back. The camera loop, the glint tests, the voice
  and the screen never wait for a model. If a browser can't run it, the page does it itself.

LICENCES / CREDITS
  Stalkerware Indicators of Compromise by Echap (CC BY 4.0) · Plus Jakarta Sans, JetBrains Mono,
  Noto Sans (SIL OFL 1.1) · ONNX Runtime Web (MIT) · Ultralytics YOLO (AGPL-3.0) · training photos from Wikimedia
  Commons (free licences) · labels made with OWLv2 (Apache-2.0) and Grounding DINO
  (Apache-2.0) · Capacitor (MIT).

BUILT ON PUBLISHED RESEARCH
- LAPD: Hidden Spy Camera Detection using Smartphone Time-of-Flight Sensors,
  NUS, ACM SenSys 2021 (people searching by eye found 46% of hidden cameras).
- Hide-and-Sweep: Detecting Concealed Cameras via LED Illumination Sweeps, KAIST, MobiSys 2026.
- Lumos: Identifying and Localizing Diverse Hidden IoT Devices in an Unfamiliar
  Environment, CMU, USENIX Security 2022.
