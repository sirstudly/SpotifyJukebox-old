const dotenv = require("dotenv");
dotenv.config();
const express = require("express");
const messenger = require("./messenger");
const spotify = require("./spotify");
const path = require("path");
const bodyParser = require("body-parser");
process.env.UV_THREADPOOL_SIZE = 128; // prevent ETIMEDOUT, ESOCKETTIMEDOUT

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server available on port ${port}`);
});

app.get("/webhook", (req, res) => {
    // Your verify token. Should be a random string.
    const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;

    // Parse the query params
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    // Checks if a token and mode is in the query string of the request
    if (mode && token) {
        // Checks the mode and token sent is correct
        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            // Responds with the challenge token from the request
            console.log("Responded to Facebook verification request");
            return res.status(200).send(challenge);
        }
    }
    // Responds with '403 Forbidden' if verify tokens do not match
    res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
    // Checks this is an event from a page subscription
    if (req.body.object === "page") {
        // Iterates over each entry - there may be multiple if batched
        req.body.entry.forEach(entry => {
            // entry.messaging is an array, but
            // will only ever contain one message, so we get index 0
            const event = entry.messaging[0];
            const senderId = event.sender.id;

            // Check if the event is a message or postback and
            // pass the event to the appropriate handler function
            if (event.message) {
                messenger.receivedMessage(event);
            }
            else if (event.postback) {
                messenger.receivedPostback(event);
            }
        });

        // Returns a '200 OK' response to all requests
        res.sendStatus(200);
    } else {
        // Returns a '404 Not Found' if event is not from a page subscription
        res.sendStatus(404);
    }
});

app.get("/spotify", (req, res) => {
    spotify.receivedAuthCode(req.query.code)
        .then( () => { res.status(200).send(); })
        .catch( err => { res.status(500).send(JSON.stringify(err)); } );

    // Perform other start-up tasks, now that we have access to the api
    spotify.initialized()
        .catch(err => console.error("Error during initialization: " + JSON.stringify(err)));
});

app.get("/search", async (req, res) => {
    res.set('Content-Type', 'application/json');
    spotify.searchTracks(req.query.terms, 0, 20)
        .then( result => { res.status(200).send(JSON.stringify(result)); })
        .catch( err => { res.status(500).send(JSON.stringify(err)); } );
});

app.get("/search-other", async (req, res) => {
    res.set('Content-Type', 'application/json');
    spotify.search(req.query.terms, ['album', 'artist', 'playlist'], 0, 20)
        .then( result => { res.status(200).send(JSON.stringify(result)); })
        .catch( err => { res.status(500).send(JSON.stringify(err)); } );
});

app.get("/get-queue", async (req, res) => {
    res.set('Content-Type', 'application/json');
    spotify.getStatus()
        .then( status => { res.status(200).send(JSON.stringify(status));} )
        .catch( err => { res.status(500).send(JSON.stringify(err)); } );
});

app.get("/get-devices", async (req, res) => {
    res.set('Content-Type', 'application/json');
    spotify.getMyDevices()
        .then( devices => { res.status(200).send(JSON.stringify(devices)); } )
        .catch( err => { res.status(500).send(JSON.stringify(err)); } );
});

app.get("/transfer-playback", async (req, res) => {
    res.set('Content-Type', 'application/json');
    spotify.transferPlaybackToDevice( req.query.deviceId, "true" === req.query.playNow )
        .then( response => { res.status(200).send(JSON.stringify(response)); } )
        .catch( err => { res.status(500).send(JSON.stringify(err)); } );
});

app.get("/queue-track", async (req, res) => {
    res.set('Content-Type', 'application/json');
    spotify.queueTrack( req.query.trackId )
        .then( state => { res.status(200).send(JSON.stringify({ status: "OK" })); } )
        .catch( err => { res.status(500).send(JSON.stringify(err)); } );
});

app.get("/get-playback-state", async (req, res) => {
    res.set('Content-Type', 'application/json');
    spotify.getPlaybackState()
        .then( state => { res.status(200).send(JSON.stringify(state)); } )
        .catch( err => { res.status(500).send(JSON.stringify(err)); } );
});

app.get("/dump-screenshot", async (req, res) => {
    spotify.saveScreenshot("screenshot.png")
        .then( () => { res.sendFile(path.join(__dirname, 'screenshot.png') ); } )
        .catch( err => { res.status(500).send(JSON.stringify(err)); } );
});

app.get("/dump-webpage", async (req, res) => {
    spotify.savePageSource("currentpage.html")
        .then( () => { res.sendFile(path.join(__dirname, 'currentpage.html') ); } )
        .catch( err => { res.status(500).send(JSON.stringify(err)); } );
});

app.get("/dump-ngrok", async (req, res) => {
    spotify.takeScreenshot("http://localhost:4040/status", "currentpage.png")
        .then( () => { res.sendFile(path.join(__dirname, 'currentpage.png') ); } )
        .catch( err => { res.status(500).send(JSON.stringify(err)); } );
});

app.get("/register-messenger-endpoint", async (req, res) => {
    spotify.updateMessengerCallback()
        .then(() => res.status(200).send(JSON.stringify({status: "OK"})))
        .catch(err => res.status(500).send(JSON.stringify(err)));
});

(async function initSpotify() {
    await spotify.initializeAuthToken()
        .catch(e => console.error("Error during initialization: " + JSON.stringify(e)));
})();
