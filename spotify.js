const SpotifyWebApi = require("spotify-web-api-node");
const agent = require('superagent').agent();
const {Builder, By, Key, until} = require('selenium-webdriver');
const chrome = require("selenium-webdriver/chrome");
const fs = require("fs");
const cq = require('concurrent-queue');
const DEFAULT_WAIT_MS = 30000;

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
        return task().catch(async(e) => {
            this.consoleError(`Attempt failed, ${limit} tries remaining. ` + e);
            if (e.message == "Unauthorized") {
                await this.initializeAuthToken();
            }
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

        await this.loginToSpotifyWeb(authorizeUrl)
            .catch(e => this.consoleError("Error initializing Spotify web: " + JSON.stringify(e)));
        this.web_auth = await this._initWebToken();
        this.consoleInfo("web-auth: " + JSON.stringify(this.web_auth));
    }

    /**
     * Web token is used as bearer authorization for certain (unpublished) API requests.
     * @returns {Promise<T | void>}
     * @private
     */
    async _initWebToken() {
        const cookies = await this.driver.manage().getCookies().then(ck => ck.map(c => c.name + "=" + c.value).join(";"));
        return await agent.get("https://open.spotify.com/get_access_token")
            .query({reason: "transport", productType: "web_player"})
            .set('Content-Type', 'application/json')
            .set('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/78.0.3904.97 Safari/537.36')
            .set('Cookie', cookies)
            .then(resp => {
                return {
                    accessToken: resp.body.accessToken,
                    tokenExpiry: resp.body.accessTokenExpirationTimestampMs
                }
            })
            .catch(err => {
                this.consoleError("Failed to initialize web token. " + JSON.stringify(err));
                throw err;
            });
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
        return Promise.resolve('OK');
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
        return Promise.resolve('OK');
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

    async search(terms, types, skip = 0, limit = 10) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return this.runTask(async () => {
            const result = await this.api.search(terms, types, {offset: skip, limit: limit});
            return result.body;
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

    async getAlbumTracks(albumId, skip = 0, limit = 10) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return this.runTask(async () => {
            const result = await this.api.getAlbum(albumId, {offset: skip, limit: limit});
            return result.body;
        });
    }

    async getPlaylist(playlistId, options) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return this.runTask(async () => {
            const result = await this.api.getPlaylist(playlistId, options);
            return result.body;
        });
    }

    async getTrack(trackId) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return this.runTask(async () => {
            const result = await this.api.getTrack(trackId);
            return result.body;
        });
    }

    async getAlbum(albumId) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return this.runTask(async () => {
            const result = await this.api.getAlbum(albumId);
            return result.body;
        });
    }

    async getArtist(artistId) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return this.runTask(async () => {
            const result = await this.api.getArtist(artistId);
            return result.body;
        });
    }

    async getArtistAlbums(artistId, skip = 0, limit = 10) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return this.runTask(async () => {
            const result = await this.api.getArtistAlbums(artistId, {offset: skip, limit: limit});
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
        if (playbackState.body.device) {
            return playbackState.body.device.volume_percent;
        }
        throw Error("No playback device found.");
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

    async queueTrack(trackURI) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return this.runTask(async () => {
            await this._verifyPlaybackState();
            const result = await this.api.addToQueue(trackURI,
                {device_id: process.env.SPOTIFY_PREFERRED_DEVICE_ID});
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
            return this.api.play({device_id: process.env.SPOTIFY_PREFERRED_DEVICE_ID});
        });
    }

    async setRepeat() {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return await this.runTask(() => {
            return this.api.setRepeat("context");
        });
    }

    async setShuffle() {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return await this.runTask(() => {
            return this.api.setShuffle(true);
        });
    }

    async play(uri) {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
        }
        return await this.runTask(async () => {
            await this.api.play({device_id: process.env.SPOTIFY_PREFERRED_DEVICE_ID, context_uri: uri});
            await this.forceRepeatShuffle();
        });
    }

    getStatus() {
        return this.webqueue(() => this._getStatus());
    }

    async _getStatus() {
        const endpoint = "https://gew-spclient.spotify.com/connect-state/v1/devices/hobs_"
            + process.env.SPOTIFY_PREFERRED_DEVICE_ID.substr(0, 35);
        let connect_state = await this._getConnectState(endpoint);
        if(connect_state.status == 401 || connect_state.status == 400) { // token expiry
            this.web_auth = await this._initWebToken();
            this.consoleInfo("web-auth: " + JSON.stringify(this.web_auth));
            connect_state = await this._getConnectState(endpoint);
        }

        const result = {
            now_playing: await this._getTrackInfo(connect_state.player_state.track.uri),
            queued_tracks: await Promise.all(connect_state.player_state.next_tracks
                .filter(t => t.metadata.is_queued == 'true')
                .map(t => this._getTrackInfo(t.uri)))
                .then(p => p)
                .catch(err => {
                    this.consoleError("Failed to retrieve track info. " + JSON.stringify(err));
                    return [];
                }),
            context: await this._getCurrentContext(connect_state.player_state.context_uri)
        };
        return result;
    }

    async _getTrackInfo(trackUri) {
        let match = trackUri.match(/track:(.*)$/);
        if (match && match.length) {
            const track = await this.getTrack(match[1]);
            return {
                song_title: track.name,
                artist: track.artists.map(a => a.name).join(', ')
            }
        }
        this.consoleError("Failed to retrieve current track from uri: " + trackUri);
        return null;
    }

    _getConnectState(url) {
        return agent.put(url)
            .auth(this.web_auth.accessToken, {type: 'bearer'})
            .set('Content-Type', 'application/json')
            .set('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/78.0.3904.97 Safari/537.36')
            // X-Spotify-ConnectionId is received from wss://gew-dealer.spotify.com/?access_token=XXXXXXXXXXX
            // although, it doesn't seem to matter? can use a made up connection id and still get response?
            // WSS also has cluster events - good for viewing live track times, etc
            .set('X-Spotify-Connection-Id', 'M2JmZmI1NTEtM2ViNi00ODFmLWFmOTEtMzk5MDViZjI0M2E2K2RlYWxlcit0Y3A6Ly9nZXcxLWRlYWxlci1iLXEwMzQuZ2V3MS5zcG90aWZ5Lm5ldDo1NzAwKzQ5MjgwODMwNjU1RjhBMEU4QkZCRDA1QUZCMTQ0MUNERDI4MzcxRUVCNUNDMzUyNDA3MDVDRDQ0OTAyNERDRDQ=')
            .buffer(true) // because content-type isn't set in the response header, we need to get the raw text rather than the (parsed) body
            .send({
                "member_type": "CONNECT_STATE",
                // web player has capabilities { "can_be_player": false, "hidden": true }
                // not sure how this is used...
                "device": {"device_info": {"capabilities": {}}}
            })
            .then(resp => JSON.parse(resp.text))
            .catch(err => {
                this.consoleError("Failed to retrieve connection state. " + JSON.stringify(err));
                // 400 = MISSING_USER_INFO (happens sometimes when spotify web session not initialized
                // 401 = token expired
                if(err.status == 400 || err.status == 401) {
                    return err;
                }
                throw err;
            });
    }

    /**
     * Checks we're still logged into Spotify and current playing something. Resumes playback if not.
     * @returns {Promise<void>}
     * @private
     */
    async _verifyPlaybackState() {
        if (!this.isAuthTokenValid()) {
            await this.refreshAuthToken();
            await this.verifyLoggedIn(); // make sure browser is ready
        }
        else {
            const loginButtons = await this.driver.findElements(By.xpath("//button[normalize-space()='Log in']"));
            if (loginButtons.length) {
                await this.verifyLoggedIn(); // make sure browser is ready
            }
        }

        // first, check that our preferred device is active and playing something
        let devices = await this.getMyDevices();
        devices = devices.body.devices.filter( dev => dev.id == process.env.SPOTIFY_PREFERRED_DEVICE_ID );
        if(devices.length == 0) {
            throw new ReferenceError("Current playback device not found.");
        }

        // now check if it's currently playing anything... start it if not
        const playback = await this.getPlaybackState();
        if (devices[0].is_active === false || !playback.body || false === playback.body.is_playing) {
            // do we have anything to play
            if (!playback.body || (playback.body.context == null && playback.body.item == null)) {
                await this.api.play({
                    device_id: process.env.SPOTIFY_PREFERRED_DEVICE_ID,
                    context_uri: process.env.SPOTIFY_FALLBACK_PLAYLIST_URI
                });
            } else { // resume previous context
                await this.api.play({device_id: process.env.SPOTIFY_PREFERRED_DEVICE_ID});
            }
        }
        await this.forceRepeatShuffle(playback);
    }

    /**
     * Sets shuffle and repeat mode on (if possible)
     * @param playbackState (optional) the current playback state
     * @returns {Promise<void>}
     */
    async forceRepeatShuffle(playbackState) {
        const playback = playbackState != null ? playbackState : await this.getPlaybackState();

        // force repeat/shuffle
        if (playback.body && !playback.body.actions.disallows.toggling_repeat_context && playback.body.repeat_state == "off") {
            await this.setRepeat();
        }
        if (playback.body && !playback.body.actions.disallows.toggling_shuffle && playback.body.shuffle_state == false) {
            await this.setShuffle();
        }
    }

    setArtistRadio(artistId) {
        return this.webqueue(() => this._setContextRadio(() => this.api.getArtist(artistId)));
    }

    setAlbumRadio(albumId) {
        return this.webqueue(() => this._setContextRadio(() => this.api.getAlbum(albumId)));
    }

    setPlaylistRadio(playlistId) {
        return this.webqueue(() => this._setContextRadio(() => this.api.getPlaylist(playlistId)));
    }

    async _setContextRadio(fnRetrieveitem) {
        await this._verifyPlaybackState();

        const item = await fnRetrieveitem();
        this.consoleInfo("Attempting to set " + item.body.name + " radio.");
        await this.driver.get(item.body.external_urls.spotify);

        // right-click on ... and click on "Start Radio"
        const ellipsis = await this.driver.wait(until.elementLocated(By.xpath("//button[@title='More']/div")), DEFAULT_WAIT_MS);
        await this.driver.actions({bridge: true}).contextClick(ellipsis).perform();
        const startRadioButton = await this.driver.wait(until.elementLocated(By.xpath("//nav[contains(@class, 'react-contextmenu--visible')]/div[normalize-space()='Start Radio']")), DEFAULT_WAIT_MS);
        await this.driver.actions({bridge: true}).move({duration:500, origin: startRadioButton}).press().pause(200).release().perform();
    }

    /**
     * Returns the currently playing context (e.g. album, track, playlist...)
     * @param contextUri spotify context URI
     * @returns {Promise<unknown>}
     * @private
     */
    async _getCurrentContext(contextUri) {
        const is_radio = contextUri.indexOf("radio") >= 0 || contextUri.indexOf("station") >= 0;
        const id = contextUri.substr(contextUri.lastIndexOf(":") + 1);
        if (contextUri.indexOf("playlist") >= 0) {
            const playlist = await this.getPlaylist(id, {fields: "name,description"})
            return {
                type: "playlist" + (is_radio ? " radio" : ""),
                name: playlist.name
            };
        }
        else if (contextUri.indexOf("album") >= 0) {
            const album = await this.getAlbum(id)
            return {
                type: "album" + (is_radio ? " radio" : ""),
                name: album.name,
                artists: album.artists.map(a => a.name).join(", ")
            };
        }
        else if (contextUri.indexOf("artist") >= 0) {
            const artist = await this.getArtist(id)
            return {
                type: "artist" + (is_radio ? " radio" : ""),
                name: artist.name
            };
        }
        else if (contextUri.indexOf("track") >= 0) {
            const track = await this.getTrack(id)
            return {
                type: "track" + (is_radio ? " radio" : ""),
                name: track.name,
                artists: track.artists.map(a => a.name).join(', ')
            };
        }
        this.consoleError("Unable to determine context from URI: " + contextUri)
        return Promise.resolve(null);
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
            const userLink = "//span[@data-testid='user-widget-name']";
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