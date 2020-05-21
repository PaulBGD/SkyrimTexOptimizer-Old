module.exports = function (window) {
    const path = require("path");
    const utils = require("util");
    const child_process = require("child_process");
    const fs = require("fs");
    const crypto = require("crypto");
    const {ipcMain} = require("electron");

    const isPowerTwo = x => (x & (x - 1)) === 0;

    const showError = msg => {
        console.error(msg);
        window.webContents.send('msg', 'Error: ' + msg);
    };

    if (!fs.existsSync("texdiag.exe")) {
        return showError("Could not find texdiag.exe");
    }

// const argv = remote.getGlobal("args");
// console.log(argv);

    let argv = [...process.argv];
    if (argv[0].indexOf('skyrimtexoptimizer.exe') > -1) {
        argv = [argv[0], argv[0], ...argv.slice(1)];
    }
    window.webContents.send('msg', JSON.stringify(argv));

    if (argv.length < 2 + 4) {
        showError("Usage: node skyrimtextoptimizer.js <infolder> <outfolder> <texsize> <normalsize> [gpu:<num>]");
        return;
    }
    let dir = argv[2];
    if (!path.isAbsolute(dir)) {
        dir = path.join(process.cwd(), dir);
    }
    let outfolder = argv[3];
    if (!path.isAbsolute(outfolder)) {
        outfolder = path.join(process.cwd(), outfolder);
    }
    if (!fs.existsSync(outfolder)) {
        fs.mkdirSync(outfolder, {recursive: true});
    }
    const texsize = +argv[4];
    if (!isPowerTwo(texsize)) {
        return showError("texsize " + texsize + " is not power of two.");
    }
    const normalsize = +argv[5];
    if (!isPowerTwo(normalsize)) {
        return showError("normalsize " + normalsize + " is not power of two.");
    }
    console.log("input:", dir, "output:", outfolder, "texsize:", texsize, "normalsize:", normalsize);

// calculate hardware

    const gpus = [];

    const stdout = child_process.execSync("wmic path win32_VideoController get name");
    const availableGpus = stdout.toString().split("\n").map(v => v.trim()).filter(v => v.length && v !== "Name");

    for (let i = 5; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.indexOf("gpu:") === 0) {
            const split = arg.split(":");
            const id = +split[1];
            if (id >= availableGpus.length || id < 0) {
                return showError("Invalid gpu id", id, "valid gpus are", availableGpus.map((v, i) => `${i}: ${v}`));
            }
            if (gpus[id] !== undefined) {
                return showError("gpu already registered for id", id);
            }
            gpus[id] = true;
        }
    }

    if (!gpus.length) {
        // auto register
        for (let i = 0; i < availableGpus.length; i++) {
            gpus[i] = 5; // idk
        }
    }

    if (!gpus.length) {
        return showError("You do not have any GPUs installed.");
    }

    let totalFiles = 0;
    let processFiles = 0;
    const queue = [];
    let searching = false;

    async function searchFiles() {
        searching = true;

        const glob = require("fast-glob");
        window.webContents.send("msg", "Looking through " + dir);
        const stream = await glob.stream([
            "!**/textures/lod", "!**/textures/DynDOLOD", "!**/*Lod*.dds", "**.dds",
        ], {dot: true, cwd: dir, onlyFiles: true, caseSensitiveMatch: false});

        for await (const entry of stream) {
            const input = path.join(dir, entry);
            const output = path.join(outfolder, entry);
            const filename = path.basename(entry);
            const isNormalMap = filename.indexOf("_n.dds");
            const neededSize = isNormalMap === filename.length - 6 ? normalsize : texsize;
            queue.push({
                input, output, neededSize, entry,
            });
            totalFiles++;
        }

        searching = false;
    }

    const gpuTasks = [];

    let paused = false;
    ipcMain.on('pause', () => paused = !paused);

    async function processQueue(window) {
        while (searching || queue.length) {
            if (queue.length && !paused) {
                for (let i = 0; i < gpus.length; i++) {
                    if (!gpuTasks[i] && queue.length) {
                        gpuTasks[i] = new Processor(queue.shift(), i, processor => {
                            processFiles++;
                            if (processFiles % 10 === 0) {
                                window.setTitle(`SkyrimTexOptimizer ` + (((processFiles / totalFiles) * 100) | 0) + "%");
                            }
                            window.webContents.send("info", {
                                completed: {
                                    entry: processor.entry,
                                    input: processor.input,
                                    output: processor.output,
                                    status: processor.status,
                                    ...processor.getStats(),
                                },
                                progress: processFiles / totalFiles,
                            });
                            gpuTasks[i] = null;
                        });
                    }
                }
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        window.webContents.send('msg', "Completed");
    }

    const exec = utils.promisify(child_process.exec);
    const execFile = utils.promisify(child_process.execFile);
    const mkdir = utils.promisify(fs.mkdir);
    const exists = utils.promisify(fs.exists);
    const readFile = utils.promisify(fs.readFile);
    const writeFile = utils.promisify(fs.writeFile);

    class Processor {
        constructor({input, output, neededSize, entry}, gpu, remove) {
            this.entry = entry;
            this.gpu = gpu;
            this.input = input;
            this.output = output;
            this.neededSize = this.newHeight = this.newWidth = neededSize;
            this.remove = remove;
            this.status = "unknown";

            this.getDetails().catch(this.error);
        }

        getStats() {
            const {width, height, newWidth, newHeight} = this;
            return {width, height, newWidth, newHeight};
        }

        error = err => {
            if (err.stdout) {
                console.error(err.stdout);
            }
            console.error("Error processing " + this.input + ": ", err, "Doing manual copy.");
            window.webContents.send('msg', "Failed to process " + this.input + " due to error " + err);
            // fs.copyFile(this.input, this.output, err => {
            //     if (err) {
            //         console.error("Failed to copy", this.input, this.output, err);
            //         window.webContents.send('msg', "Failed to copy due to error " + err);
            //     }
            // });
            this.status = "errored, copied original file";
            this.remove(this);
        };

        async getDetails() {
            const outdir = path.dirname(this.output);
            if (!await exists(outdir)) {
                await mkdir(outdir, {recursive: true});
            }
            const infoFile = this.output + ".info.mohidden";
            if (await exists(this.output) && await exists(infoFile)) {
                const str = (await readFile(infoFile)).toString();
                if (str.indexOf(":") > -1) {
                    const details = str.split(":");
                    if (details.length === 2) {
                        const origHash = details[0];
                        const oldNeededSize = +details[1];
                        if (oldNeededSize === this.neededSize) { // size is the same, check hash now
                            const newHash = crypto.createHash("SHA256").update(await readFile(this.input)).digest().toString("base64");
                            if (newHash === origHash) {
                                this.status = "previously generated";
                                this.remove(this);
                                return;
                            }
                        }
                    }
                }
            }

            const {stdout, stderr} = await execFile('"' + process.cwd() + "\\texdiag.exe\"", ["info", `"${this.input}"`, "-nologo"], {shell: true});
            if (stderr.length) {
                return this.error(stderr);
            }
            let width = -1, height = -1;
            stdout.split("\n").forEach(line => {
                if (line.indexOf("width") > -1) {
                    width = +line.split(" = ")[1].trim();
                } else if (line.indexOf("height") > -1) {
                    height = +line.split(" = ")[1].trim();
                }
            });
            if (width === -1 || height === -1) {
                return this.error("invalid details: " + stdout);
            }

            // check if we can't just resize to the needed
            this.width = width;
            this.height = height;
            if (width === height) {
                if (width < this.neededSize) {
                    this.newHeight = this.newWidth = width; // don't upscale
                }
            } else {
                this.newHeight = height;
                this.newWidth = width;
                if (isPowerTwo(height) && isPowerTwo(width)) {
                    while (this.newHeight > this.neededSize) {
                        this.newHeight /= 2;
                        this.newWidth /= 2;
                    }
                }
            }

            await this.process();
        }

        async process() {
            const outdir = path.dirname(this.output);
            const gpuFlag = this.gpu === false ? "-nogpu" : `-gpu ${this.gpu}`;
            let mipsNeeded = 1;
            let tempHeight = this.newHeight, tempWidth = this.newWidth;
            while (tempHeight > 1 || tempWidth > 1) {
                if (tempHeight > 1) {
                    tempHeight >>= 1;
                }
                if (tempWidth > 1) {
                    tempWidth >>= 1;
                }
                mipsNeeded++;
            }
            await execFile('"' + process.cwd() + `\\texconv.exe"`, [
                '-f', 'BC7_UNORM',
                '-h', String(this.newHeight),
                '-w', String(this.newWidth),
                gpuFlag,
                '-nologo',
                '-m', String(mipsNeeded),
                '-y',
                '-o', `"${outdir}"`,
                `"${this.input}"`
            ], {shell: true});
            const contents = await readFile(this.input);
            const newHash = crypto.createHash("SHA256").update(contents).digest().toString("base64");
            const infoFile = this.output + ".info.mohidden";
            await writeFile(infoFile, `${newHash}:${this.neededSize}`);
            this.status = `converted from ${this.height}/${this.width} to ${this.newHeight}/${this.newWidth}`;
            this.remove(this);
        }
    }

    Promise.all([searchFiles(window), processQueue(window)]).then(() => {
        // document.writeln("Finished!");
        console.log("finished!");
    }).catch(e => {
        console.error(e);
    });
};
