const {app, BrowserWindow} = require("electron");

// app.disableHardwareAcceleration();

function createWindow() {
    // Create the browser window.
    console.log("running..")
    const mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            // enableRemoteModule: true,
        },
    });
    mainWindow.on("close", () => app.quit());

    mainWindow.loadFile(__dirname + "/index.html");
    mainWindow.setTitle("SkyrimTexOptimizer");
    // mainWindow.setIcon("icon.png");
    mainWindow.setMenu(null);

    if (process.argv.indexOf("debug") > -1) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on("show", () => {
        setTimeout(() => {
            require("./processor.js")(mainWindow);
        }, 1000);
    });

    mainWindow.show();
}

app.whenReady().then(createWindow);
