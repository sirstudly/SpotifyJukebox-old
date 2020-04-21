const SpotifyWebApi = require("spotify-web-api-node");
const WebApiRequest = require('spotify-web-api-node/src/webapi-request.js');
const HttpManager = require('spotify-web-api-node/src/http-manager.js');
const {Builder, By, Key, until} = require('selenium-webdriver');
const chrome = require("selenium-webdriver/chrome");
const fs = require("fs");
const cq = require('concurrent-queue');
const DEFAULT_WAIT_MS = 30000;

// add missing add-to-queue functionality
SpotifyWebApi.prototype.addTrackToQueue = function (trackId, options, callback) {
    return WebApiRequest.builder(this.getAccessToken())
        .withPath('/v1/me/player/queue')
        .withQueryParameters({uri: "spotify:track:" + trackId}, options)
        .build()
        .execute(HttpManager.post, callback);
}

class Spotify {

    constructor() {
        // restrict singular access to webdriver
        // attempt twice. on failure, reinitialize everything and attempt twice more...
        this.webqueue = cq().limit({concurrency: 1}).process(task =>
            task().catch( e => {
                this.consoleError("Attempt 2: " + e);
                return task();
            } ).catch( e => {
                this.consoleError("Something wonky this way comes.. reinitializing... " + e);
                return this.driver.quit()
                    .then(() => this.sleep(2000))
                    .then(() => this.initializeAuthToken()
                        .then( () => {
                            this.consoleInfo("Attempt 3");
                            return task().catch( ex => {
                                this.consoleError("Last Attempt: " + ex);
                                return task();
                            } )
                        } ) )
            } ) )
        ;
    }

    // (re)attempt a task, a given number of times
    async runTask(task, limit = 5) {
        return task().catch(e => {
            this.consoleError(`Attempt failed, ${limit} tries remaining. ` + e);
            if (limit <= 0) {
                this.consoleError("Too many attempts. Giving up.");
                throw e;
            }
            return this.runTask(task, limit - 1);
        })
    }

    async initializeAuthToken() {
        // Initialize ChromeDriver for Queuing Tracks
        const chromeOptions = new chrome.Options();
        for( const opt of process.env.CHROME_OPTIONS.split(' ') ) {
            chromeOptions.addArguments(opt);
        }
        this.driver = await new Builder().forBrowser('chrome').setChromeOptions(chromeOptions).build();
        this.ngrokEndpoint = await this._getNgrokEndpoint();

        // Initialise connection to Spotify
        this.api = new SpotifyWebApi({
            clientId: process.env.SPOTIFY_CLIENT_ID,
            clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
            redirectUri: this.ngrokEndpoint + "/spotify"
        });

        // Generate a Url to authorize access to Spotify (requires login credentials)
        const scopes = ["user-modify-playback-state", "user-read-currently-playing", "user-read-playback-state", "streaming"];
        const authorizeUrl = this.api.createAuthorizeURL(scopes, "default-state");
        this.consoleInfo(`Authorization required. Going to ${authorizeUrl}`);

        this.loginToSpotifyWeb(authorizeUrl)
            .catch(e => this.consoleError("Error initializing Spotify web: " + JSON.stringify(e)));
    }

    async loginToSpotifyWeb(authorizeUrl) {
        await this.driver.get(authorizeUrl);
        await this.driver.findElements(By.id("auth-accept")).then( e => {
            for( const elem of e ) {
                this.consoleInfo("Spotify Authorization. Clicking on Accept");
                elem.click();
            }
        });

        // authenticate if we have to authenticate
        await this.driver.findElements(By.id("login-button")).then( e => {
            if(e.length) {
                this.doLogin()
            }
        });
    }

    isAuthTokenValid() {
        if (this.auth == undefined || this.auth.expires_at == undefined) {
            return false;
        }
        else if (this.auth.expires_at < new Date()) {
            return false;
        }
        return true;
    }

    async initialized() {
        await this.verifyLoggedIn(); // make sure browser is ready
        this.consoleInfo("Spotify is ready!");
    }

    async refreshAuthToken() {
        const result = await this.api.refreshAccessToken();

        const expiresAt = new Date();
        expiresAt.setSeconds(expiresAt.getSeconds() + result.body.expires_in);
        this.auth.access_token = result.body.access_token;
        this.auth.expires_at = expiresAt;

        this.api.setAccessToken(result.body.access_token);
        this.consoleInfo("Access Token: " + result.body.access_token);
    }

    async receivedAuthCode(authCode) {
        // Exchange the given authorization code for an access and refresh token
        const authFlow = await this.api.authorizationCodeGrant(authCode);
        this.auth = authFlow.body;

        // Note the expiry time so that we can efficiently refresh the tokens
        const expiresAt = new Date();
        expiresAt.setSeconds(expiresAt.getSeconds() + authFlow.body.expires_in);
        this.auth.expires_at = expiresAt;

        // Provide the Spotify library with the tokens
        this.api.setAccessToken(this.auth.access_token);
        this.api.setRefreshToken(this.auth.refresh_token);
        this.consoleInfo("Access Token: " + this.auth.access_token);
    }

    updateMessengerCallback() {
        return this.webqueue(() => this._updateMessengerCallback());
    }

    async _updateMessengerCallback() {
        await this.driver.get(`https://developers.facebook.com/apps/${process.env.MESSENGER_APP_ID}/messenger/settings/`);
        await this.driver.wait(until.elementLocated(By.xpath("//div[contains(text(), 'Edit Callback URL')]")), DEFAULT_WAIT_MS).click();
        const endpoint = await this.driver.wait(until.elementLocated(By.xpath(
            "//input[@placeholder='Validation requests and Webhook notifications for this object will be sent to this URL.']")), DEFAULT_WAIT_MS);
        await this._clearWebElement(endpoint);
        await endpoint.sendKeys(this.ngrokEndpoint + "/webhook");
        await this.driver.findElement(By.xpath(
            "//input[@placeholder='Token that Facebook will echo back to you as part of callback URL verification.']"))
            .sendKeys(process.env.MESSENGER_VERIFY_TOKEN);
        await this.driver.wait(until.elementLocated(By.xpath("//div[contains(text(),'Verify and Save')]")), DEFAULT_WAIT_MS).click();
    }

    async _getNgrokEndpoint() {
        await this.driver.get("http://localhost:4040/status");
        const ngrok_url = await this.driver.wait(until.elementLocated(By.xpath(
            "//h4[text()='command_line']/../div/table/tbody/tr[th[text()='URL']]/td")), DEFAULT_WAIT_MS).getText();
        this.consoleInfo("ngrok URL: " + ngrok_url);
        return ngrok_url;
    }

    async searchTracks(terms, skip = 0, limit = 10) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return this.runTask(async () => {
            const result = await this.api.searchTracks(terms, {offset: skip, limit: limit});
            return result.body.tracks;
        });
    }

    async searchPlaylists(terms, skip = 0, limit = 10) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return this.runTask(async () => {
            const result = await this.api.searchPlaylists(terms, {offset: skip, limit: limit});
            return result.body.playlists;
        });
    }

    async getPlaylistTracks(playlistId, skip = 0, limit = 10) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return this.runTask(async () => {
            const result = await this.api.getPlaylistTracks(playlistId, {offset: skip, limit: limit});
            return result.body;
        });
    }

    async getPlaylist(playlistId) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return this.runTask(async () => {
            const result = await this.api.getPlaylist(playlistId);
            return result.body;
        });
    }

    async getMyDevices() {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return await this.api.getMyDevices();
    }

    async transferPlaybackToDevice(deviceId, playNow) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return await this.api.transferMyPlayback( { deviceIds: [deviceId], play: playNow });
    }

    async getPlaybackState() {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return await this.runTask(() => {
            return this.api.getMyCurrentPlaybackState();
        });
    }

    async getVolume() {
        const playbackState = await this.runTask(() => {
            return this.getPlaybackState();
        });
        return playbackState.body.device.volume_percent;
    }

    async setVolume(volume) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        if (volume.trim().match(/^1?\d{0,2}$/)) {
            const v = parseInt(volume, 10);
            if (typeof v == 'number' && v <= 100) {
                return await this.runTask(() => {
                    return this.api.setVolume(v);
                });
            }
        }
        throw new Error("Volume can only be set to a whole number between 0 and 100.");
    }

    async queueTrack(trackId) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return this.runTask(async () => {
            const result = await this.api.addTrackToQueue(trackId);
            this.consoleInfo("Queued track response: " + JSON.stringify(result));
        });
    }

    async skipTrack() {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return await this.runTask(() => {
            return this.api.skipToNext();
        });
    }

    async pausePlayback() {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return await this.runTask(() => {
            return this.api.pause();
        });
    }

    async resumePlayback() {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return await this.runTask(() => {
            return this.api.play();
        });
    }

    async setPlaylist(playlistId) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return await this.runTask(() => {
            return this.api.play({context_uri: "spotify:playlist:" + playlistId});
        });
    }

    getStatus() {
        return this.webqueue(() => this._getStatus());
    }

    async _getStatus() {
        await this.driver.get("https://open.spotify.com/queue");

        // authenticate if we have to authenticate
        const loginButtons = await this.driver.findElements(By.xpath("//button[normalize-space()='Log in']"));
        if (loginButtons.length) {
            await this.verifyLoggedIn(); // make sure browser is ready
            await this.driver.get("https://open.spotify.com/queue"); // reload page
        }

        // wait for content panel to load because I can't guarantee there will always be something
        // in Now Playing or Next in Queue, but I assume that there will *always* be something in Next Up
        await this.driver.wait(until.elementLocated(By.xpath("//h2[normalize-space(text())='Next Up']")), DEFAULT_WAIT_MS);

        const nowPlaying = await this._listTracks("Now Playing");
        const nextInQueue = await this._listTracks("Next in Queue");
        return {
            now_playing: nowPlaying.length == 0 ? null : nowPlaying[0],
            queued_tracks: nextInQueue,
            context: await this._currentContext()
        };
    }

    // list all tracks with the given heading on https://open.spotify.com/queue
    async _listTracks(heading) {
        let trackItemXPath = "//div[h2[normalize-space(text())='{0}']]//div[contains(@class, 'tracklist-name') or contains(@class, 'second-line')]";
        let tracks = [];
        const trackItems = await this.driver.findElements(By.xpath(trackItemXPath.replace("{0}", heading)));
        for(let i = 0; i < trackItems.length; i+=2) {
            let artistAlbum = (await trackItems[i + 1].getText()).split("\n•\n");
            let nextTrack = {
                song_title: await trackItems[i].getText(),
                    artist: artistAlbum[0]
            };
            if(artistAlbum.length > 1) {
                nextTrack.album = artistAlbum[1];
            }
            tracks.push(nextTrack);
        }
        return tracks;
    }

    // returns the currently playing context (e.g. album, track, playlist...)
    async _currentContext() {
        return await this.getPlaybackState().then(async (ps) => {
            if (ps.body && ps.body.context) {
                if (ps.body.context.type == "playlist") {
                    const playlist = await this.runTask(() => {
                        return this.api.getPlaylist(ps.body.context.uri.substr("spotify:playlist:".length), {fields: "name,description"});
                    });
                    return {
                        type : "playlist",
                        name : playlist.body.name
                    };
                }
                if (ps.body.context.type == "album") {
                    const album = await this.runTask(() => {
                        return this.api.getAlbum(ps.body.context.uri.substr("spotify:album:".length));
                    });
                    return {
                        type : "album",
                        name : album.body.name,
                        artists: album.body.artists.map(a => a.name).join(", ")
                    };
                }
            }
        }).catch(e => {
            this.consoleError("Error attempting to retrieve playback state. " + e);
            return null;
        });
    }

    async verifyLoggedIn() {
        await this.driver.get("https://open.spotify.com/browse/featured#_=_");
        const loginButtons = await this.driver.findElements(By.xpath("//button[normalize-space()='Log in']"));
        if( loginButtons.length ) {
            await loginButtons[0].click();
            await this.driver.wait(until.stalenessOf(loginButtons[0]), DEFAULT_WAIT_MS);
            await this.doLogin();
        }
        else {
            this.consoleInfo("CHROME: No login button. Already logged in?");
            const userLink = "//span[@class='UserWidget__user-link']";
            await this.driver.wait(until.elementLocated(By.xpath(userLink)), DEFAULT_WAIT_MS);
            const accountName = await this.driver.findElement(By.xpath(userLink)).getText();
            this.consoleInfo("CHROME: Logged in as " + accountName);
        }
    }

    async doLogin() {
        if (process.env.SPOTIFY_USERNAME) {
            const usernameField = await this.driver.findElement(By.id("login-username"));
            await this._clearWebElement(usernameField);
            await usernameField.sendKeys(process.env.SPOTIFY_USERNAME);
            await this.driver.findElement(By.id("login-password")).sendKeys(process.env.SPOTIFY_PASSWORD);
            const loginButton = await this.driver.findElement(By.id("login-button"));
            await loginButton.click();
            await this.driver.wait(until.stalenessOf(loginButton), DEFAULT_WAIT_MS);
        } else {
            const FB_LOGIN_BTN_PATH = By.xpath("//a[normalize-space()='Log in with Facebook']");
            const loginViaFacebook = await this.driver.wait(until.elementLocated(FB_LOGIN_BTN_PATH), DEFAULT_WAIT_MS);
            await loginViaFacebook.click();
            await this.driver.wait(until.stalenessOf(loginViaFacebook), DEFAULT_WAIT_MS);
            const loginBtns = await this.driver.findElements(By.id("loginbutton"));
            if (loginBtns.length) { // FB credentials may be cached
                this.consoleInfo("Logging in via Facebook");
                await this.driver.findElement(By.id("email")).sendKeys(process.env.FB_EMAIL);
                await this.driver.findElement(By.id("pass")).sendKeys(process.env.FB_PASSWORD);
                await loginBtns[0].click();
                await this.driver.wait(until.stalenessOf(loginBtns[0]), DEFAULT_WAIT_MS);
            }
            const authButtons = await this.driver.findElements(By.id("auth-accept"));
            if (authButtons.length) {
                this.consoleInfo("Accepting consent for updating Spotify");
                await authButtons[0].click();
                await this.driver.wait(until.stalenessOf(authButtons[0]), DEFAULT_WAIT_MS);
            }
        }
    }

    async takeScreenshot(url, filename) {
        await this.driver.get(url)
            .then( () => {
                this.saveScreenshot(filename);
            });
    }

    async savePageSource(filename) {
        const currentUrl = await this.driver.getCurrentUrl();
        this.consoleInfo( "Writing source to " + filename + " for " + currentUrl );
        await this.driver.getPageSource().then(src => {
            fs.writeFileSync(filename, src, function (err) { throw err; });
        });
    }

    async saveScreenshot(filename) {
        await this.driver.takeScreenshot().then(
            function (image, err) {
                fs.writeFileSync(filename, image, 'base64', function (err) { throw err; });
            }
        );
    }

    async _clearWebElement(elem) {
        await this.driver.executeScript(elt => elt.select(), elem);
        await elem.sendKeys(Key.BACK_SPACE);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    consoleInfo(message) {
        console.info(new Date().toLocaleString() + " " + message);
    }

    consoleError(message) {
        console.error(new Date().toLocaleString() + " " + message);
    }
}

module.exports = new Spotify();