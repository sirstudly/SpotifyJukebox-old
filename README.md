# Spotify Jukebox

> This simple Node.js application is a demonstration of how to use the Facebook Messenger and Spotify APIs together to create a 'Jukebox Bot'.

## Update 2019-11-23

This fork updates the original version which uses a custom "playlist" with one that does a true "queue" operation without altering the current playlist on Spotify. It does this by logging into Spotify via Chrome (Selenium) and queuing the song via the web player. This is the best solution that I could find as there is no "Queue" operation available via the Spotify API.

Note, due to licensing restrictions on the integrated web player, this doesn't work on Linux distributions since it uses Chromium rather than Chrome.

# .env variables

The included .env file contains placeholder keys which you will need to provide. For more information about what these mean and how to obtain them, please see the associated tutorial at [https://medium.com/p/70c863337331](https://medium.com/p/70c863337331)

# Installation

 - Clone this repo
 - Run `npm install` to install dependencies
 - Run `npm start` to launch the app


When the application launches, follow the link in the console window to authenticate with Spotify


# Instructions
   * Run ``./ngrok http 3000``
   * <strike>Login to https://developer.spotify.com/dashboard/applications, update Client ID and Secret.
      * Under Edit, update Callback to ngrok https address.
      * Update SPOTIFY parameters in ``.env``</strike>
   * Run ``node update-spotify-endpoint.js``
   * Run ``npm start``
   * <strike>Login to https://developers.facebook.com/apps/
      * Under Messenger, Settings -> Update Webhooks (e.g. https://xxxxx.ngrok.io/webhook). Verify token is an agreed upon token you make up (MESSENGER_VERIFY_TOKEN).
      * Verify and save
      * If this is the first time, Generate Token - update ``.env``</strike>
   * Hit http://localhost:3000/register-messenger-endpoint with any web browser.
   * Send the following POST request:
```
curl -X POST \
  'https://graph.facebook.com/v5.0/me/messenger_profile?access_token=<FILL IN ACCESS TOKEN HERE>' \
  -H 'Content-Type: application/json' \
  -d '{
    "get_started": {
        "payload": "{\"command\": \"GET_STARTED\"}"
    },
    "greeting": [
        {
            "locale": "default",
            "text": "Hi {{user_first_name}}! Just start typing your request and we'\''ll see what we have in our catalogue."
        }
    ],
    "persistent_menu": [
        {
            "locale": "default",
            "call_to_actions": [
                {
                    "type": "postback",
                    "title": "What'\''s playing?",
                    "payload": "{\"command\": \"STATUS\"}"
                }
            ]
        }
    ]
}'
```