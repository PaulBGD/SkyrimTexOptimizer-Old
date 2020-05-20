const path = require("path");
const glob = require("fast-glob");
const os = require("os");
const utils = require("util");
const child_process = require("child_process");
const fs = require("fs");
const crypto = require("crypto");
const cryptoAsync = require("@ronomon/crypto-async");

const isPowerTwo = x => (x & (x - 1)) === 0;

if (process.argv.length < 2 + 4) {
    console.error("Usage: node skyrimtextoptimizer.js <infolder> <outfolder> <texsize> <normalsize> [gpu:<num>] ")
    console.error("Example: node skyrimtextoptimizer.js mymod 2048 1024 13 gpu:0 gpu:1")
    process.exit(1);
}
let dir = process.argv[2];
if (!path.isAbsolute(dir)) {
    dir = path.join(process.cwd(), dir);
}
let outfolder = process.argv[3];
if (!path.isAbsolute(outfolder)) {
    outfolder = path.join(process.cwd(), outfolder);
}
if (!fs.existsSync(outfolder)) {
    fs.mkdirSync(outfolder, {recursive: true});
}
const texsize = +process.argv[4];
if (!isPowerTwo(texsize)) {
    console.error("texsize " + texsize + " is not power of two.")
    process.exit(1);
}
const normalsize = +process.argv[5];
if (!isPowerTwo(normalsize)) {
    console.error("normalsize " + normalsize + " is not power of two.")
    process.exit(1);
}

// calculate hardware

const gpus = [];

const stdout = child_process.execSync("wmic path win32_VideoController get name");
const availableGpus = stdout.toString().split("\n").map(v => v.trim()).filter(v => v.length && v !== "Name");

for (let i = 5; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.indexOf("gpu:") === 0) {
        const split = arg.split(":");
        const id = +split[1];
        if (id >= availableGpus.length || id < 0) {
            console.error("Invalid gpu id", id, "valid gpus are", availableGpus.map((v, i) => `${i}: ${v}`));
            process.exit(1);
        }
        if (gpus[id] !== undefined) {
            console.error("gpu already registered for id", id);
            process.exit(1);
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
    console.error("You do not have any GPUs installed.");
    process.exit(1);
}

const queue = [];
let searching = false;

async function searchFiles() {
    searching = true;
    const stream = await glob.stream([
        '!**/textures/lod/**', '!**/textures/DynDOLOD', '!**/*Lod*.dds', '**.dds'
    ], {dot: true, cwd: dir, onlyFiles: true, caseSensitive: false});

    for await (const entry of stream) {
        const input = path.join(dir, entry);
        const output = path.join(outfolder, entry);
        const filename = path.basename(entry);
        const isNormalMap = filename.indexOf("_n.dds");
        const neededSize = isNormalMap === filename.length - 6 ? normalsize : texsize;
        queue.push({
            input, output, neededSize, needsMips: true
        });
    }
    searching = false;
}

const gpuTasks = [];

async function processQueue() {
    while (searching || queue.length) {
        if (queue.length) {
            for (let i = 0; i < gpus.length; i++) {
                if (!gpuTasks[i]) {
                    gpuTasks[i] = new Processor(queue.shift(), i, processor => {
                        console.log("Completed", processor.output, "on gpu", i, processor.getStats());
                        gpuTasks[i] = null;
                    })
                }
            }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

const exec = utils.promisify(child_process.exec);
const mkdir = utils.promisify(fs.mkdir);
const exists = utils.promisify(fs.exists);
const readFile = utils.promisify(fs.readFile);
const writeFile = utils.promisify(fs.writeFile);
const hash = utils.promisify(cryptoAsync.hash);

class Processor {
    constructor({input, output, neededSize, needsMips}, gpu, remove) {
        this.gpu = gpu;
        this.input = input;
        this.output = output;
        this.neededSize = this.newHeight = this.newWidth = neededSize;
        this.needsMIps = needsMips;
        this.remove = remove;

        this.getDetails().catch(this.error);
    }

    getStats() {
        const {width, height, newWidth, newHeight} = this;
        return {width, height, newWidth, newHeight};
    }

    error = err => {
        console.error("Error processing " + this.input + ": ", err, "Doing manual copy.");
        fs.copyFile(this.input, this.output, err => {
            if (err) {
                console.error("Failed to copy", this.input, this.output);
            }
        });
        this.remove(this);
    };

    async getDetails() {
        const infoFile = this.output + ".info.mohidden";
        if (await exists(this.output) && await exists(infoFile)) {
            const details = (await readFile(infoFile)).toString().split(":");
            if (details.length === 2) {
                const origHash = details[0];
                const oldNeededSize = +details[1];
                if (oldNeededSize === this.neededSize) { // size is the same, check hash now
                    const newHash = (await hash('SHA512-256', await readFile(this.input))).toString('base64');
                    if (newHash === origHash) {
                        this.remove(this);
                        return;
                    }
                }
            }
        }

        const {stdout, stderr} = await exec(`texdiag.exe info ${this.input}`);
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
        if (!await exists(outdir)) {
            await mkdir(outdir, {recursive: true});
        }
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
        await exec(`texconv.exe -f BC7_UNORM -h ${this.newHeight} -w ${this.newWidth} ${gpuFlag} -nologo -m ${mipsNeeded} -y -o ${outdir} ${this.input}`);
        const newHash = (await hash('SHA512-256', await readFile(this.input))).toString('base64');
        const infoFile = this.output + ".info.mohidden";
        await writeFile(infoFile, `${newHash}:${this.neededSize}`);
        this.remove(this);
    }
}

Promise.all([searchFiles(), processQueue()]).then(() => {
    process.exit(0);
}).catch(e => {
    console.error(e);
    process.exit(1)
});
