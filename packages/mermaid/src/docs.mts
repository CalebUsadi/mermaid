/* eslint-disable no-console */

/**
 * @file Transform documentation source files into files suitable for publishing and optionally copy
 *   the transformed files from the source directory to the directory used for the final, published
 *   documentation directory. The list of files transformed and copied to final documentation
 *   directory are logged to the console. If a file in the source directory has the same contents in
 *   the final directory, nothing is done (the final directory is up-to-date).
 * @example
 *   docs
 *   Run with no option flags
 *
 * @example
 *   docs --verify
 *   If the --verify option is used, it only _verifies_ that the final directory has been updated with the transformed files in the source directory.
 *   No files will be copied to the final documentation directory, but the list of files to be changed is shown on the console.
 *   If the final documentation directory does not have the transformed files from source directory
 *   - a message to the console will show that this command should be run without the --verify flag so that the final directory is updated, and
 *   - it will return a fail exit code (1)
 *
 * @example
 *   docs --git
 *   If the --git option is used, the command `git add docs` will be run after all transformations (and/or verifications) have completed successfully
 *   If not files were transformed, the git command is not run.
 *
 * @todo Ensure that the documentation source and final paths are correct by using process.cwd() to
 *   get their absolute paths. Ensures that the location of those 2 directories is not dependent on
 *   where this file resides.
 *
 * @todo Write a test file for this. (Will need to be able to deal .mts file. Jest has trouble with
 *   it.)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { exec } from 'child_process';
import { globby } from 'globby';
import { JSDOM } from 'jsdom';
import type { Code, Root } from 'mdast';
import { posix, dirname } from 'path';
import prettier from 'prettier';
import { remark } from 'remark';
// @ts-ignore No typescript declaration file
import flatmap from 'unist-util-flatmap';

const MERMAID_MAJOR_VERSION = (
  JSON.parse(readFileSync('../mermaid/package.json', 'utf8')).version as string
).split('.')[0];

const verifyOnly: boolean = process.argv.includes('--verify');
const git: boolean = process.argv.includes('--git');
const vitepress: boolean = process.argv.includes('--vitepress');
const noHeader: boolean = process.argv.includes('--noHeader') || vitepress;

// These paths are from the root of the mono-repo, not from the
// mermaid sub-directory
const SOURCE_DOCS_DIR = 'src/docs';
const FINAL_DOCS_DIR = vitepress ? 'src/vitepress' : '../../docs';

const AUTOGENERATED_TEXT = `> **Warning**
> ## THIS IS AN AUTOGENERATED FILE. DO NOT EDIT. 
> ## Please edit the corresponding file in package/mermaid/src/docs.`;

const LOGMSG_TRANSFORMED = 'transformed';
const LOGMSG_TO_BE_TRANSFORMED = 'to be transformed';
const LOGMSG_COPIED = `, and copied to ${FINAL_DOCS_DIR}`;

const WARN_DOCSDIR_DOESNT_MATCH = `Changed files were transformed in ${SOURCE_DOCS_DIR} but do not match the files in ${FINAL_DOCS_DIR}. Please run pnpm docs:build after making changes to ${SOURCE_DOCS_DIR} to update the ${FINAL_DOCS_DIR} directory with the transformed files.`;

// TODO: Read from .prettierrc?
const prettierConfig: prettier.Config = {
  useTabs: false,
  tabWidth: 2,
  endOfLine: 'auto',
  printWidth: 100,
  singleQuote: true,
};

let filesWereTransformed = false;

/**
 * Given a source file name and path, return the documentation destination full path and file name
 * Create the destination path if it does not already exist.
 *
 * @param {string} file - Name of the file (including full path)
 * @returns {string} Name of the file with the path changed from the source directory to final
 *   documentation directory
 * @todo Possible Improvement: combine with lint-staged to only copy files that have changed
 */
const changeToFinalDocDir = (file: string): string => {
  const newDir = file.replace(SOURCE_DOCS_DIR, FINAL_DOCS_DIR);
  mkdirSync(dirname(newDir), { recursive: true });
  return newDir;
};

/**
 * Log messages to the console showing if the transformed file copied to the final documentation
 * directory or still needs to be copied.
 *
 * @param {string} filename Name of the file that was transformed
 * @param {boolean} wasCopied Whether or not the file was copied
 */
const logWasOrShouldBeTransformed = (filename: string, wasCopied: boolean) => {
  const changeMsg = wasCopied ? LOGMSG_TRANSFORMED : LOGMSG_TO_BE_TRANSFORMED;
  let logMsg: string;
  logMsg = `  File ${changeMsg}: ${filename}`;
  if (wasCopied) {
    logMsg += LOGMSG_COPIED;
  }
  console.log(logMsg);
};

/**
 * If the file contents were transformed, set the _filesWereTransformed_ flag to true and copy the
 * transformed contents to the final documentation directory if the doCopy flag is true. Log
 * messages to the console.
 *
 * @param {string} filename Name of the file that will be verified
 * @param {boolean} [doCopy=false] Whether we should copy that transformedContents to the final
 *   documentation directory. Default is `false`
 * @param {string} [transformedContent] New contents for the file
 */
const copyTransformedContents = (filename: string, doCopy = false, transformedContent?: string) => {
  const fileInFinalDocDir = changeToFinalDocDir(filename);
  const existingBuffer = existsSync(fileInFinalDocDir)
    ? readFileSync(fileInFinalDocDir)
    : Buffer.from('#NEW FILE#');
  const newBuffer = transformedContent ? Buffer.from(transformedContent) : readFileSync(filename);
  if (existingBuffer.equals(newBuffer)) {
    return; // Files are same, skip.
  }

  filesWereTransformed = true;
  if (doCopy) {
    writeFileSync(fileInFinalDocDir, newBuffer);
  }
  logWasOrShouldBeTransformed(fileInFinalDocDir, doCopy);
};

const readSyncedUTF8file = (filename: string): string => {
  return readFileSync(filename, 'utf8');
};

const transformToBlockQuote = (content: string, type: string) => {
  const title = type === 'warning' ? 'Warning' : 'Note';
  return `> **${title}** \n> ${content.replace(/\n/g, '\n> ')}`;
};

/**
 * Transform a markdown file and write the transformed file to the directory for published
 * documentation
 *
 * 1. Add a `mermaid-example` block before every `mermaid` or `mmd` block On the docsify site (one
 *    place where the documentation is published), this will show the code used for the mermaid
 *    diagram
 * 2. Add the text that says the file is automatically generated
 * 3. Use prettier to format the file Verify that the file has been changed and write out the changes
 *
 * @param file {string} name of the file that will be verified
 */
const transformMarkdown = (file: string) => {
  const doc = readSyncedUTF8file(file).replace(/<MERMAID_VERSION>/g, MERMAID_MAJOR_VERSION);
  const ast: Root = remark.parse(doc);
  const out = flatmap(ast, (c: Code) => {
    if (c.type !== 'code' || !c.lang) {
      return [c];
    }

    // Convert mermaid code blocks to mermaid-example blocks
    if (['mermaid', 'mmd', 'mermaid-example'].includes(c.lang)) {
      c.lang = 'mermaid-example';
      return [c, Object.assign({}, c, { lang: 'mermaid' })];
    }

    // Transform codeblocks into block quotes.
    if (['note', 'tip', 'warning'].includes(c.lang)) {
      return [remark.parse(transformToBlockQuote(c.value, c.lang))];
    }

    return [c];
  });

  let transformed = remark.stringify(out);
  if (!noHeader) {
    // Add the AUTOGENERATED_TEXT to the start of the file
    transformed = `${AUTOGENERATED_TEXT}\n${transformed}`;
  }

  if (vitepress && file === 'src/docs/index.md') {
    // Skip transforming index if vitepress is enabled
    transformed = doc;
  }

  const formatted = prettier.format(transformed, {
    parser: 'markdown',
    ...prettierConfig,
  });
  copyTransformedContents(file, !verifyOnly, formatted);
};

/**
 * Transform an HTML file and write the transformed file to the directory for published
 * documentation
 *
 * - Add the text that says the file is automatically generated Verify that the file has been changed
 *   and write out the changes
 *
 * @param filename {string} name of the HTML file to transform
 */
const transformHtml = (filename: string) => {
  /**
   * Insert the '...auto generated...' comment into an HTML file after the<html> element
   *
   * @param fileName {string} file name that should have the comment inserted
   * @returns {string} The contents of the file with the comment inserted
   */
  const insertAutoGeneratedComment = (fileName: string): string => {
    const fileContents = readSyncedUTF8file(fileName).replace(
      /<MERMAID_VERSION>/g,
      MERMAID_MAJOR_VERSION
    );

    if (noHeader) {
      return fileContents;
    }

    const jsdom = new JSDOM(fileContents);
    const htmlDoc = jsdom.window.document;
    const autoGeneratedComment = jsdom.window.document.createComment(AUTOGENERATED_TEXT);

    const rootElement = htmlDoc.documentElement;
    rootElement.prepend(autoGeneratedComment);
    return jsdom.serialize();
  };

  const transformedHTML = insertAutoGeneratedComment(filename);
  const formattedHTML = prettier.format(transformedHTML, {
    parser: 'html',
    ...prettierConfig,
  });
  copyTransformedContents(filename, !verifyOnly, formattedHTML);
};

const getFilesFromGlobs = async (globs: string[]): Promise<string[]> => {
  globs.push('!**/dist');
  if (!vitepress) {
    globs.push('!**/.vitepress', '!**/vite.config.ts', '!src/docs/index.md');
  }
  return await globby(globs, { dot: true });
};

/** Main method (entry point) */
(async () => {
  if (verifyOnly) {
    console.log('Verifying that all files are in sync with the source files');
  }

  const sourceDirGlob = posix.join('.', SOURCE_DOCS_DIR, '**');
  const action = verifyOnly ? 'Verifying' : 'Transforming';

  const mdFiles = await getFilesFromGlobs([posix.join(sourceDirGlob, '*.md')]);
  console.log(`${action} ${mdFiles.length} markdown files...`);
  mdFiles.forEach(transformMarkdown);

  const htmlFiles = await getFilesFromGlobs([posix.join(sourceDirGlob, '*.html')]);
  console.log(`${action} ${htmlFiles.length} html files...`);
  htmlFiles.forEach(transformHtml);

  const otherFiles = await getFilesFromGlobs([sourceDirGlob, '!**/*.md', '!**/*.html']);
  console.log(`${action} ${otherFiles.length} other files...`);
  otherFiles.forEach((file: string) => {
    copyTransformedContents(file, !verifyOnly); // no transformation
  });

  if (filesWereTransformed) {
    if (verifyOnly) {
      console.log(WARN_DOCSDIR_DOESNT_MATCH);
      process.exit(1);
    }
    if (git) {
      console.log(`Adding changes in ${FINAL_DOCS_DIR} folder to git`);
      exec('git add docs');
    }
  }
})();
