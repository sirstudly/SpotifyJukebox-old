const dotenv = require("dotenv");
dotenv.config();
const Request = require("request-promise");
const {Builder, By, Key, until} = require('selenium-webdriver');
const chrome = require("selenium-webdriver/chrome");
const DEFAULT_WAIT_MS = 30000;

/**
 * Updates callback URL in Spotify.
 * @param driver
 * @param ngrokCallbackUrl
 * @returns {Promise<void>}
 */
async function updateSpotifyCallback(driver, ngrokCallbackUrl) {
    await driver.get("https://developer.spotify.com/dashboard/applications/" + process.env.SPOTIFY_CLIENT_ID);
    if ((await driver.findElements(By.xpath("//button[text()='Log in']"))).length > 0) {
        const mainWindowHandle = await driver.getWindowHandle();
        await driver.findElement(By.xpath("//button[text()='Log in']")).click();
        console.info("Waiting for login to Spotify");
        if (process.env.SPOTIFY_USERNAME) {
            // switch to newly opened window
            const allHandles = await driver.getAllWindowHandles();
            for (let i = 0; i < allHandles.length; i++) {
                if (allHandles[i] != mainWindowHandle) {
                    await driver.switchTo().window(allHandles[i]);
                }
            }
            await driver.findElement(By.id("login-username")).sendKeys(process.env.SPOTIFY_USERNAME);
            await driver.findElement(By.id("login-password")).sendKeys(process.env.SPOTIFY_PASSWORD);
            await driver.findElement(By.id("login-button")).click();
            await driver.switchTo().window(mainWindowHandle);
        }
        await driver.wait(until.urlIs("https://developer.spotify.com/dashboard/applications"), DEFAULT_WAIT_MS);
        await driver.get("https://developer.spotify.com/dashboard/applications/" + process.env.SPOTIFY_CLIENT_ID);
    }

    await driver.wait(until.elementLocated(By.xpath("//button[@data-target='#settings-modal']")), DEFAULT_WAIT_MS).click();

    // remove previous binding(s)
    await new Promise(resolve => setTimeout(resolve, 1000)); // need to pause for a second
    const prev_bindings = await driver.findElements(By.xpath("//form-list[@label='Redirect URIs']//a[@class='item-remove']"));
    for (let i = 0; i < prev_bindings.length; i++) {
        await prev_bindings[i].click();
        await driver.wait(until.stalenessOf(prev_bindings[i]));
    }

    await driver.findElement(By.id("newRedirectUri")).sendKeys(ngrokCallbackUrl);
    await driver.findElement(By.xpath("//form-list[@label='Redirect URIs']//button[@ng-click='addItem()']")).click();
    await driver.findElement(By.xpath("//button[@ng-click='update(application)']")).click();
}

(async () => {

    // first check if ngrok is running
    await Promise.resolve(Request({uri: "http://localhost:4040/inspect/http"})
        .catch(error => { console.error("Is ngrok running?"); process.exit(1); } ));

    const chromeOptions = new chrome.Options();
    for( const opt of process.env.CHROME_OPTIONS.split(' ') ) {
        chromeOptions.addArguments(opt);
    }
    const driver = await new Builder().forBrowser('chrome').setChromeOptions(chromeOptions).build();
    try {
        await driver.get("http://localhost:4040/status");
        const ngrok_url = await driver.wait(until.elementLocated(By.xpath(
            "//h4[text()='command_line']/../div/table/tbody/tr[th[text()='URL']]/td")), DEFAULT_WAIT_MS).getText();
        console.log("ngrok URL: " + ngrok_url);

        console.log("Updating callback URL in Spotify...");
        await updateSpotifyCallback(driver, ngrok_url + "/spotify");

        console.log("Run 'npm start' now.");

    } catch (error) {
        console.error(error);
    } finally {
        await driver.quit();
    }
})();
