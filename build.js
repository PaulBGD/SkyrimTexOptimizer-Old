const AdmZip = require('adm-zip');

const zip = new AdmZip();
zip.addLocalFile("build/skyrimtexoptimizer.exe");
zip.addLocalFile("node_modules/@ronomon/crypto-async/binding.node");
zip.writeZip("build/SkyrimTexOptimizer.zip");
