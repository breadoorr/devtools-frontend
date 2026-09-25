import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

const checkoutDirectory = resolve(import.meta.dirname, '..', '..', '..');
const buildDirectory = resolve(checkoutDirectory, process.argv[2] ?? 'out/Release');
const outputFile = resolve(checkoutDirectory, process.argv[3] ?? 'out/css-to-source-devtools-frontend.zip');
const generatedDirectory = join(buildDirectory, 'gen');
const manifestFile = join(generatedDirectory, 'input_grd_files.json');
const stagingDirectory = join(buildDirectory, 'css-to-source-browser-assets');
const archiveTimestamp = '2000-01-01T00:00:00Z';

if (!existsSync(manifestFile)) {
  throw new Error(`DevTools build did not produce ${manifestFile}. Run autoninja before packaging.`);
}

const packagedFiles = JSON.parse(readFileSync(manifestFile, 'utf8'));
if (!Array.isArray(packagedFiles) || packagedFiles.some(file => typeof file !== 'string')) {
  throw new Error(`DevTools packaging manifest is not a list of file paths: ${manifestFile}`);
}

const frontendPrefix = 'front_end/';
const frontendFiles = packagedFiles.filter(file => file.startsWith(frontendPrefix));
if (!frontendFiles.includes(`${frontendPrefix}devtools_app.html`)) {
  throw new Error(`DevTools packaging manifest does not contain front_end/devtools_app.html: ${manifestFile}`);
}

rmSync(stagingDirectory, {recursive: true, force: true});
for (const file of frontendFiles) {
  if (file.includes('..') || file.includes('\\')) {
    throw new Error(`Invalid path in DevTools packaging manifest: ${file}`);
  }
  const source = join(generatedDirectory, ...file.split('/'));
  if (!existsSync(source)) {
    throw new Error(`DevTools packaging manifest references a missing file: ${source}`);
  }
  const destination = join(stagingDirectory, 'devtools-frontend', ...file.slice(frontendPrefix.length).split('/'));
  mkdirSync(dirname(destination), {recursive: true});
  cpSync(source, destination);
}

mkdirSync(dirname(outputFile), {recursive: true});
rmSync(outputFile, {force: true});
const jarExecutable = process.env.JAVA_HOME ?
    join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar') :
    'jar';
execFileSync(
    jarExecutable,
    ['--create', '--file', outputFile, `--date=${archiveTimestamp}`, '-C', stagingDirectory, '.'],
    {stdio: 'inherit'},
);
rmSync(stagingDirectory, {recursive: true, force: true});
console.log(`[css-to-source] packaged ${frontendFiles.length} files into ${outputFile}`);
