# EduOS for Roku

A SceneGraph channel that shows a family's Time Capsules and school history on
a Roku TV. It's look-only: a Roku signs in with a code (the device flow in
`src/device-sign-in.js`), gets a read-only session, and the server refuses any
change from it, whatever the channel sends.

## Screens

| Screen | What it does |
| --- | --- |
| Welcome (district address) | First run: the district's EduOS address (https only). It's checked against `/health` before it's saved. |
| Sign in | A code and a QR code (drawn from the server's `qr` rows) to approve on a phone or computer at `/device/`. Polls at the server's interval, slows down when asked, and gets a new code when one runs out or is declined. |
| Screen lock | An optional 4- or 6-number PIN for this TV, asked for when EduOS starts and after 5 to 30 quiet minutes (10 by default). Five free tries, then a wait that doubles from 30 seconds to 15 minutes. "Sign this TV out" works without the PIN. |
| Home: Time Capsules | Every capsule the account can see, its status and when it opens. Opening one shows its message and what's inside once the server allows it. |
| Photos | Full screen, with the caption (or description) and "2 of 5"; Left/Right to move, Back to close. |
| Home: History | For a parent, one entry per child; for a student, their own. Newest first, a page at a time ("Show more..."), each item readable in full. |
| Home: Screen lock | Set, change, or turn off the PIN; choose the quiet time; lock now. |
| Home: Sign out of this TV | Ends the session on the server and forgets it (and the PIN) here. |

Photos: a SceneGraph `Poster` can't send the session header, so the channel
asks `/api/history/photos/:assetId?format=json` (with the session) for the
photo's 60-second private link and the Poster loads the picture from that.
Press OK on a capsule or history item with photos to see them full screen;
Left and Right move between them.

## Build

Node 22 or later. From this folder:

```sh
npm ci --ignore-scripts
```

then the `lint` script (BrightScript checks with brighterscript and bslint)
and the `build` script, which writes `out/eduos-roku.zip`. CI does the same in
the `roku-channel` job (not a required check) and keeps the zip as the
`eduos-roku-channel` artifact.

Artwork: put the real channel posters and splash screens in `art/` (names and
sizes in [art/README.md](art/README.md)). Until then the build uses plain
placeholders.

## Try it on a Roku

1. Turn on developer mode: on the remote press Home three times, Up twice,
   then Right, Left, Right, Left, Right. Set a developer password.
2. Open `http://<the Roku's IP address>` in a browser, sign in as `rokudev`
   with that password, and upload `out/eduos-roku.zip`.
3. The district's server needs `DEVICE_SIGN_IN_ENABLED=true`. Without it the
   sign-in screen says TV sign-in isn't turned on.

## Publishing

Publishing needs a Roku developer account. The zip is signed on a Roku in
developer mode (its Packager page) and uploaded in the Roku Developer
Dashboard, along with the store artwork and description. Nothing in this
repository signs or publishes the channel.
