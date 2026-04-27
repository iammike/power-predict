# Get your Strava archive

Power Predict needs your full ride history to build an accurate power-duration curve. The fastest way to import it &mdash; and the only one that doesn't burn through Strava's tight API rate limits &mdash; is to request your account archive directly from Strava and drop the zip into Power Predict.

The archive contains every ride you've ever uploaded, including the raw power streams. **Strava prepares it offline and emails you when it's ready** &mdash; usually within a few hours, sometimes faster, sometimes the next day.

## Step 1 &mdash; Request the archive

1. Go to [Strava &rarr; Settings &rarr; My Account](https://www.strava.com/account).
2. Scroll to the bottom and click **Download or Delete Your Account**.
3. Click **Get Started** under "Download Request (optional)".
4. Click **Request Your Archive**.

You will **not** lose your account. The "Download or Delete" page bundles both options, but the archive request is independent of deletion.

## Step 2 &mdash; Wait for the email

Strava will email a link titled **"Your Strava Data Export"** to the address on your account, typically within 1&ndash;6 hours. The link expires after about 7 days, so download promptly.

## Step 3 &mdash; Download and drop in

You'll get a file like `strava_export_<id>.zip` (often hundreds of MB if you have a lot of rides). Save it somewhere you can find it.

Open Power Predict and drag the zip onto the upload area. Everything happens in your browser:

- The zip is unpacked locally
- Each `activities/<id>.fit.gz` file is parsed for its power stream
- Power-duration curves are computed and displayed

**Nothing is uploaded to a server.** Raw streams stay on your machine. Only the derived numbers (best 5-min power, etc.) are stored if you choose to sync your account later.

## What's in the archive

For reference, the zip contains:

| Path | Contents |
|------|----------|
| `activities.csv` | Metadata for every activity (date, name, distance, duration, etc.) |
| `activities/<id>.fit.gz` | Full FIT file per activity &mdash; power, HR, cadence, GPS at 1Hz |
| `activities/<id>.tcx.gz` / `.gpx.gz` | Older or non-FIT activities |
| `media/` | Photos attached to activities (Power Predict ignores these) |
| `profile.csv`, `bikes.csv`, etc. | Account profile info (also ignored) |

## Troubleshooting

**"My archive is huge."** That's normal &mdash; mine is over a gigabyte. Power Predict streams it entry-by-entry; you don't need to extract it manually.

**"Some activities don't have power."** Power Predict only uses activities with a power meter recording. Older rides, rides on a different bike, and rides recorded by phone-only typically have no power stream. They're skipped automatically.

**"My archive email never came."** Check spam. If it's been more than 24 hours, request again from the same page &mdash; old requests don't block new ones.

**"I'm worried about uploading my data."** Power Predict parses the archive entirely in your browser using JavaScript. The zip never leaves your machine during onboarding. You can verify this by opening DevTools &rarr; Network while you drop the file: there will be no upload requests.

## Updating later

You only need to do the archive dance once. After the initial import, you can connect Strava via OAuth and Power Predict will pull individual new rides as you complete them &mdash; no more archive requests required.
