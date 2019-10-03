const dotenv = require("dotenv");
dotenv.config();
const {Builder, By, Key, until} = require('selenium-webdriver');
const chrome = require("selenium-webdriver/chrome");
const chromeOptions = new chrome.Options();
chromeOptions.addArguments("user-data-dir=chromeprofile");
chromeOptions.addArguments("--start-maximized");
chromeOptions.addArguments("--headless");
chromeOptions.addArguments("--disable-gpu");
const DEFAULT_WAIT_MS = 10000;

// Use to login to FB for the first time
(async () => {
    const driver = await new Builder().forBrowser('chrome').setChromeOptions(chromeOptions).build();

    async function savePageSource(filename) {
        const url = await driver.getCurrentUrl();
        await driver.getPageSource().then(src => {
            require('fs').writeFile(filename, src, function (err) {
                if (err) {
                    return console.log(err);
                }
                console.log(filename + " was saved of " + url);
            });
        });
    }

    async function saveScreenshot(filename) {
        await driver.takeScreenshot().then(
            function (image, err) {
                require('fs').writeFile(filename, image, 'base64', function (err) {
                    if (err) {
                        return console.log(err);
                    }
                    console.log(filename + " was saved!");
                });
            }
        );
    }

    async function sleep(ms) {
        await driver.wait(until.elementsLocated(By.xpath("dummy-element-that-doesnt-exist")), ms)
            .catch(() => {
                return;
            }); // do nothing
    }

    try {
        await driver.get("https://www.facebook.com");

        await driver.findElements(By.id("loginbutton"))
            .then( async (loginBtns) => {
                if(loginBtns.length) { // FB credentials may be cached
                    console.log("sending username + password");
                    await driver.findElement(By.id("email")).sendKeys(process.env.FB_EMAIL);
                    await driver.findElement(By.id("pass")).sendKeys(process.env.FB_PASSWORD);
                    await loginBtns[0].click();
                    await driver.wait(until.stalenessOf(loginBtns[0]), DEFAULT_WAIT_MS);
                }
            });
        // if this is a new device;
        await driver.findElements(By.id("checkpointSubmitButton"))
            .then( async (buttons) => {
                if(buttons.length) {
                    console.log("Clicking on continue");
                    await buttons[0].click();
                    await driver.wait(until.stalenessOf(buttons[0]), DEFAULT_WAIT_MS);

                    console.log("clicking on approve by text...");
                    await driver.findElement(By.xpath("//span[text()='Text a security code to your phone']")).click();
                    await driver.findElement(By.id("checkpointSubmitButton"))
                        .then(async (continueButton) => {
                            console.log("Clicking on continue");
                            await continueButton.click();
                            await driver.wait(until.stalenessOf(continueButton), DEFAULT_WAIT_MS);
                        });

                    await driver.findElement(By.id("checkpointSubmitButton"))
                        .then(async (continueButton) => {
                            console.log("Clicking on continue");
                            await continueButton.click();
                            await driver.wait(until.stalenessOf(continueButton), DEFAULT_WAIT_MS);
                        });

                    await driver.findElement(By.name("captcha_response"))
                        .then( async (field) => {
                            while( ! (process.env.CAPTCHA && process.env.CAPTCHA.length) ) {
                                console.log("Waiting " + (DEFAULT_WAIT_MS/1000) + "s for CAPTCHA to be saved in .env");
                                await sleep(DEFAULT_WAIT_MS);
                                dotenv.config();
                                if (process.env.CAPTCHA && process.env.CAPTCHA.length) {
                                    console.log("Applying captcha " + process.env.CAPTCHA);
                                    await field.sendKeys(process.env.CAPTCHA);
                                    return;
                                }
                            }
                        });

                    await driver.findElement(By.id("checkpointSubmitButton"))
                        .then(async (continueButton) => {
                            console.log("Clicking on continue");
                            await continueButton.click();
                            await driver.wait(until.stalenessOf(continueButton), DEFAULT_WAIT_MS);
                        });

                    await driver.findElement(By.id("checkpointSubmitButton"))
                        .then(async (continueButton) => {
                            console.log("Clicking on continue");
                            await continueButton.click();
                            await driver.wait(until.stalenessOf(continueButton), DEFAULT_WAIT_MS);
                        });
                }
            });

        await savePageSource("fbloggedin.html");
        await saveScreenshot( "fbloggedin.png" );

    } finally {
        await driver.quit();
    }
})();
