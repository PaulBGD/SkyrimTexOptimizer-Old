const AdmZip = require('adm-zip');

console.log("Zipping..");

const zip = new AdmZip();
zip.addLocalFolder("dist/win-unpacked", "data/tools/SkyrimTexOptimizer/");
zip.addLocalFile("skyrimtexoptimizer.bat", "data/tools/SkyrimTexOptimizer/");
zip.writeZip("dist/SkyrimTexOptimizer.zip");
