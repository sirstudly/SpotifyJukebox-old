const spotify = require("./spotify");
const Request = require("request-promise");

const Commands = {
    ADD_TRACK: "ADD_TRACK",
    SEARCH_MORE: "SEARCH_MORE",
    STATUS: "STATUS",
    GET_STARTED: "GET_STARTED"
}

class Messenger {
    receivedMessage(event) {
        // Inform the user that we've read their message 
        this.sendReadReceipt(event.sender.id);

        // for traceability, debugging
        this.logEvent(event);

        // Here I'm just treating quick-reply buttons as postback buttons, to avoid repeating code
        if (event.message.quick_reply != null) {
            return this.receivedPostback({ sender: event.sender, postback: event.message.quick_reply });
        }
        else if( typeof event.message.text == 'undefined' || event.message.text.toLowerCase() === 'status'
                || event.message.text.toLowerCase().replace("'", '')
                    .replace('’', '').startsWith('whats playing')) {
            this.getStatus(event.sender.id);
        }
        else {
            this.searchMusic(event.sender.id, event.message.text);
        }
    }

    async receivedPostback(event) {
        this.logEvent(event); // for traceability, debugging
        const payload = JSON.parse(event.postback.payload);
        switch (payload.command) {
            case Commands.GET_STARTED: {
                this.sendMessage(event.sender.id, {text: "What would you like to hear?"});
                break;
            }
            case Commands.ADD_TRACK: {
                // Add the track (contained in the payload) to the Spotify queue.
                // Note: We created this payload data when we created the button in searchMusic()
                this.sendTypingIndicator(event.sender.id, true);
                try {
                    await spotify.queueTrack(payload.track);
                    this.sendMessage(event.sender.id, {text: "Thanks! Your track has been submitted."});
                }
                catch (error) {
                    this.consoleError(error);
                    this.sendMessage(event.sender.id, { text: error instanceof ReferenceError ?
                            error.message : "Oops.. Computer says no. Maybe try again later."
                    });
                }
                finally {
                    this.sendTypingIndicator(event.sender.id, false);
                }
                break;
            }
            case Commands.SEARCH_MORE: {
                // Call the search method again with the parameters in the payload
                this.searchMusic(event.sender.id, payload.terms, payload.skip, payload.limit);
                break;
            }
            case Commands.STATUS: {
                this.getStatus(event.sender.id);
                break;
            }
        }
    }

    async searchMusic(sender, terms, skip = 0, limit = 10) {
        // Begin a 'typing' indicator to show that we're working on a response
        this.sendTypingIndicator(sender, true);

        // We want to pull results from Spotify 'paginated' in batches of 20.
        // We'll order those by popularity and present the user with the top few results
        const queryBegin = skip - (skip % 20);
        const queryEnd = queryBegin + 20;
        await spotify.searchTracks(terms, queryBegin, queryEnd)
            .then( result => {
                if (result.items.length === 0) {
                    this.sendMessage(sender, { text: "Sorry, we couldn't find that." });
                }
                else if (result.items.length > 0) {
                    // If there are enough remaining results, we can give the user
                    // a 'More' button to pull further results
                    const remainingResults = result.total - limit - skip;
                    const showMoreButton = (remainingResults > 0);

                    // Sort the results by popularity
                    result.items.sort((a, b) => (b.popularity - a.popularity));
                    // Take the correct subset of tracks according to skip and limit
                    result.items = result.items.slice(skip, skip + limit);

                    const message = {
                        attachment: {
                            type: "template",
                            payload: {
                                template_type: "generic",
                                elements: [],
                            }
                        }
                    };

                    // Add the more button if there were enough results. We provide the button
                    // with all of the data it needs to be able to call this search function again and
                    // get the next batch of results
                    if (showMoreButton) {
                        message.quick_replies = [{
                            content_type: "text",
                            title: "More Results",
                            payload: JSON.stringify({
                                command: Commands.SEARCH_MORE,
                                terms: terms,
                                skip: skip + limit,
                                limit: limit
                            })
                        }];
                    }

                    // Build a list of buttons for each result track
                    message.attachment.payload.elements = result.items.map((track) => {
                        this.sortTrackArtwork(track);
                        return {
                            title: track.name,
                            subtitle: this.generateArtistList(track),
                            buttons: [this.generatePostbackButton("Add", { command: Commands.ADD_TRACK, track: track.id })],
                            image_url: track.album.images.length > 0 ? track.album.images[0].url : ""
                        };
                    });

                    // Send the finished result to the user
                    this.sendMessage(sender, message);
                }
            })
            .catch( err => {
                this.consoleError("Error searching for " + terms + ": " + err);
                this.sendMessage(sender, { text: "Oops.. Computer says no. Maybe try again later." });
            });

        // Cancel the 'typing' indicator
        this.sendTypingIndicator(sender, false);
    }

    async getStatus(sender) {
        this.sendTypingIndicator(sender, true);
        await spotify.getStatus()
            .then( status => {
                let message = "";
                if (status.now_playing) {
                    message = "Now Playing: " + status.now_playing.song_title + " by " + status.now_playing.artist + "\n";
                }
                if (status.queued_tracks && status.queued_tracks.length) {
                    message += "Queued Tracks:\n";
                    for (let i = 1; i <= status.queued_tracks.length; i++) {
                        const track = status.queued_tracks[i - 1];
                        message += i + ": " + track.song_title + " by " + track.artist + "\n";
                    }
                } else {
                    message += "There are no queued tracks.";
                }
                this.sendMessage(sender, {text: message.trim()});
            })
            .catch( error => {
                this.consoleError( error );
                this.sendMessage(sender, { text: "Oops.. Computer says no. Maybe try again later." });
            });
        this.sendTypingIndicator(sender, false);
    }

    generatePostbackButton(title, payload) {
        return {
            type: "postback",
            title: title,
            payload: JSON.stringify(payload)
        };
    }

    generateArtistList(track) {
        // Assemble the list of artists as a comma separated list
        let artists = "";
        track.artists.forEach((artist) => {
            artists = artists + ", " + artist.name;
        });
        artists = artists.substring(2);
        return artists;
    }

    sortTrackArtwork(track) {
        // Sort the album images by size order ascending
        track.album.images.sort((a, b) => {
            return b.width - a.width;
        });
    }

    getSendOptions(recipient) {
        const result = {
            uri: "https://graph.facebook.com/v2.6/me/messages",
            qs: {
                access_token: process.env.MESSENGER_ACCESS_TOKEN
            },
            body: {
                recipient: {
                    id: recipient
                }
            },
            json: true
        };
        return result;
    }

    sendTypingIndicator(recipient, typing) {
        const options = this.getSendOptions(recipient);
        options.body.sender_action = typing ? "typing_on" : "typing_off";

        return this.send(options);
    }

    sendReadReceipt(recipient) {
        const options = this.getSendOptions(recipient);
        options.body.sender_action = "mark_seen";

        return this.send(options);
    }

    sendMessage(recipient, message) {
        const options = this.getSendOptions(recipient);
        options.body.message = message;

        return this.send(options);
    }

    async send(payload) {
        return this.attemptSend(payload, 5);
    }

    async attemptSend(payload, attemptsRemaining) {
        if(attemptsRemaining > 0) {
            await Request.post(payload)
                .catch(error => {
                    this.consoleError(`Delivery to Facebook failed (${error}), ${attemptsRemaining} attempts remaining.`);
                    this.attemptSend(payload, attemptsRemaining - 1);
                });
        }
        else {
            this.consoleError("Unable to deliver message. Giving up.");
        }
    }

    logEvent(event) {
        Promise.resolve(Request({
            uri: `https://graph.facebook.com/${event.sender.id}?fields=first_name,last_name&access_token=${process.env.MESSENGER_ACCESS_TOKEN}`,
            json: true })
        .then(resp => {
            const msg = event.message && event.message.text ? `"${event.message.text}"` :
                event.postback && event.postback.payload ? `"${event.postback.payload}"` : JSON.stringify( event );
            this.consoleInfo(`Received ${msg} from ${resp.first_name} ${resp.last_name}`)
        })
        .catch(error => this.consoleError(`Failed to log event (${error})`)));
    }

    consoleInfo(message) {
        console.info(new Date().toLocaleString() + " " + message);
    }

    consoleError(message) {
        console.error(new Date().toLocaleString() + " " + message);
    }
}

module.exports = new Messenger();