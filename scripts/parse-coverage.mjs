#!/usr/bin/env node

/**
 * Script to parse Node.js test coverage output and calculate per-directory coverage.
 * 
 * Usage: node scripts/parse-coverage.mjs < coverage-output.txt
 * 
 * The script reads Node.js test coverage output from stdin, parses the table,
 * and calculates coverage statistics for specified directories.
 */

import { readFile } from 'node:fs/promises';

// Directories we care about for reporting
const TARGET_DIRECTORIES = [
  'src/',
  'src/catalog/',
  'src/mcp/',
  'src/sdk/'
];

// Parse a coverage percentage string like "91.97" or "100.00"
function parsePercentage(str) {
  const cleaned = str.trim();
  if (cleaned === '' || cleaned === '-') {
    return null;
  }
  return parseFloat(cleaned);
}

// Parse a line from the coverage table
function parseCoverageLine(line, currentPath = []) {
  // Lines in TAP format start with '# ', need to strip that
  const cleanLine = line.startsWith('# ') ? line.slice(2) : line;
  
  // Match lines like: "  app.js                               |  91.97 |    89.13 |   88.24 | 103-107 111-113 179-180 240-249"
  // Or: "   index.js                               | 100.00 |   100.00 |  100.00 | "
  // Or: "  catalog                                 |        |          |         | " (directory)
  const match = cleanLine.match(/^(\s*)([^|]+)\|\s*([\d.-]+)\s*\|\s*([\d.-]+)\s*\|\s*([\d.-]+)\s*\|\s*(.*)$/);
  if (!match) {
    return { type: 'skip' };
  }

  const [, indent, filePart, lineCoverage, branchCoverage, funcCoverage, uncoveredLines] = match;
  const file = filePart.trim();
  const indentLevel = indent.length;
  
  // Determine if this is a directory or file
  const hasCoverageData = lineCoverage.trim() !== '' && lineCoverage.trim() !== '-';
  
  if (!hasCoverageData) {
    // This is a directory line
    return {
      type: 'directory',
      name: file,
      indentLevel
    };
  } else {
    // This is a file with coverage data
    // Build the full path from current directory context
    const fullPath = [...currentPath, file].join('/');
    
    return {
      type: 'file',
      file: fullPath,
      lineCoverage: parsePercentage(lineCoverage),
      branchCoverage: parsePercentage(branchCoverage),
      funcCoverage: parsePercentage(funcCoverage),
      uncoveredLines: uncoveredLines.trim(),
      indentLevel
    };
  }
}

// Determine which directory a file belongs to
function getDirectoryForFile(filePath) {
  // Check if file is in our target directories
  for (const dir of TARGET_DIRECTORIES) {
    if (filePath.startsWith(dir)) {
      return dir;
    }
  }
  
  // Check if it's a src file but not in our specific subdirectories
  if (filePath.startsWith('src/')) {
    // Find the first directory component after src/
    const parts = filePath.split('/');
    if (parts.length > 1) {
      return `src/${parts[1]}/`;
    }
  }
  
  return 'other';
}

// Calculate statistics for a collection of coverage entries
function calculateStats(entries) {
  if (entries.length === 0) {
    return { count: 0, lineAvg: 0, branchAvg: 0, funcAvg: 0 };
  }

  const validLineEntries = entries.filter(e => e.lineCoverage !== null);
  const validBranchEntries = entries.filter(e => e.branchCoverage !== null);
  const validFuncEntries = entries.filter(e => e.funcCoverage !== null);

  const lineAvg = validLineEntries.length > 0
    ? validLineEntries.reduce((sum, e) => sum + e.lineCoverage, 0) / validLineEntries.length
    : 0;
  
  const branchAvg = validBranchEntries.length > 0
    ? validBranchEntries.reduce((sum, e) => sum + e.branchCoverage, 0) / validBranchEntries.length
    : 0;
  
  const funcAvg = validFuncEntries.length > 0
    ? validFuncEntries.reduce((sum, e) => sum + e.funcCoverage, 0) / validFuncEntries.length
    : 0;

  return {
    count: entries.length,
    lineAvg: Math.round(lineAvg * 100) / 100,
    branchAvg: Math.round(branchAvg * 100) / 100,
    funcAvg: Math.round(funcAvg * 100) / 100
  };
}

// Main function
async function main() {
  let input;
  try {
    // Read from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    input = Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    console.error('Error reading stdin:', error.message);
    process.exit(1);
  }

  const lines = input.split('\n');
  let inCoverageTable = false;
  const coverageEntries = [];

  // Parse the coverage table
  let directoryStack = [];
  for (const line of lines) {
    // In TAP format, coverage report lines start with '# '
    const cleanLine = line.startsWith('# ') ? line.slice(2) : line;
    
    if (cleanLine.includes('start of coverage report')) {
      inCoverageTable = true;
      continue;
    }
    
    if (cleanLine.includes('end of coverage report')) {
      inCoverageTable = false;
      continue;
    }
    
    if (inCoverageTable && cleanLine.includes('|')) {
      // Skip separator lines
      if (cleanLine.includes('---') || cleanLine.includes('===')) {
        continue;
      }
      
      // Skip header line
      if (cleanLine.includes('file') && cleanLine.includes('line %')) {
        continue;
      }
      
      const result = parseCoverageLine(line, directoryStack);
      
      if (result.type === 'directory') {
        // Update directory stack based on indentation
        while (directoryStack.length > 0 && directoryStack.length * 2 > result.indentLevel) {
          directoryStack.pop();
        }
        directoryStack.push(result.name);
      } else if (result.type === 'file') {
        // Update directory stack for file indentation
        while (directoryStack.length > 0 && directoryStack.length * 2 > result.indentLevel) {
          directoryStack.pop();
        }
        
        coverageEntries.push(result);
      }
      // Skip entries are ignored
    }
  }

  // Group by directory
  const byDirectory = {};
  for (const entry of coverageEntries) {
    const dir = getDirectoryForFile(entry.file);
    if (!byDirectory[dir]) {
      byDirectory[dir] = [];
    }
    byDirectory[dir].push(entry);
  }

  // Calculate statistics for each directory
  const directoryStats = {};
  for (const [dir, entries] of Object.entries(byDirectory)) {
    directoryStats[dir] = calculateStats(entries);
  }

  // Debug: print some parsed entries
  if (process.env.DEBUG) {
    console.error('DEBUG: First 10 coverage entries:');
    for (let i = 0; i < Math.min(10, coverageEntries.length); i++) {
      console.error(`  ${coverageEntries[i].file}: ${coverageEntries[i].lineCoverage}%`);
    }
    console.error(`Total entries: ${coverageEntries.length}`);
    
    console.error('\nDEBUG: Directory breakdown:');
    for (const [dir, entries] of Object.entries(byDirectory)) {
      console.error(`  ${dir}: ${entries.length} files`);
    }
  }

  // Print report
  console.log('📊 Code Coverage Report');
  console.log('=' .repeat(80));
  console.log('\nPer-directory coverage (focus areas):');
  console.log('-' .repeat(80));
  
  // Print target directories first
  for (const targetDir of TARGET_DIRECTORIES) {
    const stats = directoryStats[targetDir];
    if (stats) {
      console.log(`${targetDir.padEnd(15)} | Files: ${stats.count.toString().padStart(3)} | Line: ${stats.lineAvg.toFixed(2).padStart(6)}% | Branch: ${stats.branchAvg.toFixed(2).padStart(6)}% | Func: ${stats.funcAvg.toFixed(2).padStart(6)}%`);
    } else {
      console.log(`${targetDir.padEnd(15)} | No coverage data found`);
    }
  }

  console.log('\nOther directories:');
  console.log('-' .repeat(80));
  
  // Print other directories
  const otherDirs = Object.keys(directoryStats).filter(dir => !TARGET_DIRECTORIES.includes(dir));
  for (const dir of otherDirs.sort()) {
    const stats = directoryStats[dir];
    console.log(`${dir.padEnd(15)} | Files: ${stats.count.toString().padStart(3)} | Line: ${stats.lineAvg.toFixed(2).padStart(6)}% | Branch: ${stats.branchAvg.toFixed(2).padStart(6)}% | Func: ${stats.funcAvg.toFixed(2).padStart(6)}%`);
  }

  // Calculate and print overall stats (excluding test files)
  const srcEntries = coverageEntries.filter(entry => entry.file.startsWith('src/'));
  const overallStats = calculateStats(srcEntries);
  
  console.log('\n' + '=' .repeat(80));
  console.log(`Overall source coverage: ${overallStats.lineAvg.toFixed(2)}% line, ${overallStats.branchAvg.toFixed(2)}% branch, ${overallStats.funcAvg.toFixed(2)}% function`);
  console.log(`(based on ${overallStats.count} source files)`);
  console.log('=' .repeat(80));
  
  // Output for GitHub Actions summary
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log('\n::group::GitHub Actions Summary');
    console.log('### 📊 Code Coverage Report');
    console.log('');
    console.log('| Directory | Files | Line Coverage | Branch Coverage | Function Coverage |');
    console.log('|-----------|-------|---------------|-----------------|-------------------|');
    
    for (const targetDir of TARGET_DIRECTORIES) {
      const stats = directoryStats[targetDir];
      if (stats) {
        console.log(`| ${targetDir} | ${stats.count} | ${stats.lineAvg.toFixed(2)}% | ${stats.branchAvg.toFixed(2)}% | ${stats.funcAvg.toFixed(2)}% |`);
      }
    }
    
    console.log('');
    console.log(`**Overall:** ${overallStats.lineAvg.toFixed(2)}% line, ${overallStats.branchAvg.toFixed(2)}% branch, ${overallStats.funcAvg.toFixed(2)}% function coverage`);
    console.log('::endgroup::');
  }
}

// Run the script
main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});