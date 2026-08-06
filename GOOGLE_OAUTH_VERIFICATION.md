# FablePeak Google OAuth verification submission

This is the evidence package for removing Google's unverified-app warning from
general customer YouTube onboarding. Do not submit until the demo video link is
available and the complete flow has been replayed against production.

## Requested sensitive scopes

- `https://www.googleapis.com/auth/youtube.readonly`
- `https://www.googleapis.com/auth/youtube.upload`

`yt-analytics.readonly` is intentionally excluded because the current product
does not call the YouTube Analytics API.

## Scope justification (Google field, 1,000-character limit)

FablePeak is a social publishing application. After a user explicitly selects
Connect YouTube, `youtube.readonly` is used to retrieve that authenticated
user's channel ID, title, thumbnail and channel totals so FablePeak can confirm
which channel was connected and display its identity and metrics inside the
user's workspace. `youtube.upload` is used only when that user explicitly
creates or schedules a video post and chooses YouTube; FablePeak uploads the
user-supplied video to the connected channel as private, with the title and
description supplied by the user. These permissions are not used for unrelated
accounts, data is not sold or shared, and the connection can be disconnected.
More limited scopes are insufficient: channel identity/totals require
`youtube.readonly`, while publishing to the user's channel requires
`youtube.upload`.

## Demo video checklist

Upload one unlisted YouTube video and paste its URL into Google Cloud's **Data
access → Demo video** field. The recording must be in English and show the full
browser address bar.

1. Start signed out of FablePeak, then sign in and open a workspace.
2. Open **Connections** and click **Connect YouTube**.
3. Show Google's unverified-app screen in the recording. Google explicitly
   expects it for the test account while the review is pending.
4. Continue to the OAuth consent screen and show both requested permissions.
5. Approve access and return to FablePeak.
6. Show the connected channel's name/avatar in FablePeak, proving use of
   `youtube.readonly`.
7. Create a post with a small video, choose only YouTube, and publish it.
8. Show the successful result/link in FablePeak.
9. Open YouTube Studio and show that the same video exists on the connected
   channel with **Private** visibility, proving use of `youtube.upload`.
10. Return to Connections and show the disconnect control. Do not disconnect
    until the reviewer flow has been checked end to end.

The recording should not expose passwords, client secrets, access tokens, or
private customer data. Use a developer-owned test channel and a non-sensitive
sample video.

## Additional information (Google field, 1,000-character limit)

FablePeak's production web application is https://fablepeak.com. OAuth returns
to the server-side callback at
https://lghsvxwuaebvotutyjtt.supabase.co/functions/v1/oauth-callback. Provider
credentials are stored server-side, application-encrypted, and scoped to the
authorizing user's workspace. YouTube uploads are created with Private
visibility. Reviewers can reproduce the flow by signing in to the supplied
review account, opening Connections, choosing Connect YouTube, approving the
two permissions, and publishing a post containing a small video. The app uses
one web OAuth client in Google Cloud project `fablepeak`.

## Submission gate

- Production deployment requests only the two scopes above.
- Google Cloud Data access no longer lists `yt-analytics.readonly`.
- Demo video shows every step and uses the production OAuth client.
- Demo video is uploaded as unlisted and its URL is available.
- Scope justification and additional information match the deployed behaviour.
- Reviewer credentials, if supplied, are temporary and shared only through
  Google's review form—not committed to this repository.
