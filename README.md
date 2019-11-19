# Spotify Jukebox

> This simple Node.js application is a demonstration of how to use the Facebook Messenger and Spotify APIs together to create a 'Jukebox Bot'.

# .env variables

The included .env file contains placeholder keys which you will need to provide. For more information about what these mean and how to obtain them, please see my associated tutorial at [https://medium.com/p/70c863337331](https://medium.com/p/70c863337331)

# Installation

 - Clone this repo
 - Run `npm install` to install dependencies
 - Run `npm start` to launch the app


When the application launches, follow the link in the console window to authenticate with Spotify


# Instructions
   * Run ``./ngrok http 3000``
   * Login to https://developer.spotify.com/dashboard/applications, update Client ID and Secret.
      * Under Edit, update Callback to ngrok https address.
      * Update SPOTIFY parameters in ``.env``
   * Run ``npm start``
   * Login to https://developers.facebook.com/apps/
      * Under Messenger, Settings -> Update Webhooks (e.g. https://xxxxx.ngrok.io/webhook). Verify token is an agreed upon token you make up (MESSENGER_VERIFY_TOKEN).
      * Verify and save
      * If this is the first time, Generate Token - update ``.env``
