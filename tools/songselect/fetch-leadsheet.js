#!/usr/bin/env node
/**
 * SongSelect Lead Sheet Fetcher
 * 
 * Fetches lead sheet PDFs from SongSelect using the internal API.
 * 
 * Usage:
 *   node fetch-leadsheet.js "Song Title"
 *   node fetch-leadsheet.js "Goodness Of God" --author "Ed Cash"
 *   node fetch-leadsheet.js "Goodness Of God" --download ./output/
 *   node fetch-leadsheet.js "Goodness Of God" --ccli 7117726
 *
 * Options:
 *   --author, -a    Filter by author name
 *   --ccli          Use CCLI number instead of search
 *   --download, -d  Directory to save PDF (default: prints to stdout)
 *   --headless      Run headless (default for non-interactive use)
 *   --key           Transpose key (default: Ab)
 *   --orientation   portrait or landscape
 *   --papersize     Letter or A4
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import https from 'https';
import http from 'http';

const COOKIES_FILE = join(process.cwd(), 'cookies.json');

// ── Argument parsing ────────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(flags) {
  for (const flag of flags) {
    const eq = args.find(a => a.startsWith(`${flag}=`));
    if (eq) return eq.split('=', 2)[1];
    const idx = args.indexOf(flag);
    if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  }
  return undefined;
}

function getNonFlagArgs() {
  return args.filter(a => !a.startsWith('--'));
}

const query = getNonFlagArgs()[0];
const author = getArg(['--author', '-a']);
const ccliNum = getArg(['--ccli']);
const downloadDir = getArg(['--download', '-d']);
const transposeKey = getArg(['--key']) || 'Ab';
const orientation = getArg(['--orientation']) || 'portrait';
const paperSize = getArg(['--papersize']) || 'Letter';
const headless = args.includes('--headless') || downloadDir !== undefined;

if (!query && !ccliNum) {
  console.error('Usage: node fetch-leadsheet.js "Song Title" [--ccli 123456] [--download ./dir/] [--key Ab]');
  process.exit(1);
}

// ── Cookie health check ─────────────────────────────────────────
async function checkCookieHealth() {
  try {
    const raw = readFileSync(COOKIES_FILE, 'utf-8');
    const cookies = JSON.parse(raw);
    
    // Check for auth cookies
    if (!cookies.some(c => c.name === 'CCLI_JWT_AUTH')) {
      console.error('');
      console.error('⚠️  No CCLI_JWT_AUTH cookie found!');
      console.error('   Run: ./songselect.sh renew');
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Cookie error:', err.message);
    console.error('   Run: ./songselect.sh renew');
    process.exit(1);
  }
}

// ── Cookie loading ──────────────────────────────────────────────
async function loadCookies() {
  try {
    const raw = readFileSync(COOKIES_FILE, 'utf-8');
    const cookies = JSON.parse(raw);
    return cookies;
  } catch (err) {
    console.error('❌ Cannot load cookies from', COOKIES_FILE);
    console.error('   Run: node export-cookies.js');
    process.exit(1);
  }
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const cookies = await loadCookies();
  
  // Quick health check
  await checkCookieHealth();
  
  const browser = await chromium.launch({
    headless,
    channel: 'chrome',
  });

  try {
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    
    console.log(`🎵 Fetching SongSelect lead sheet...`);
    if (ccliNum) {
      console.log(`   CCLI #${ccliNum}`);
    } else {
      console.log(`   "${query}"${author ? ` by "${author}"` : ''}`);
    }
    
    // ── Step 1: Search ─────────────────────────────────────────
    console.log('   Searching...');
    const searchQuery = ccliNum ? `CCLI ${ccliNum}` : query;
    
    await page.goto('https://songselect.ccli.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    
    // Find and use the search bar
    const searchInput = page.locator('input[placeholder*="Search Title"], input[type="search"]').first();
    
    if (await searchInput.count() > 0) {
      await searchInput.click();
      await searchInput.fill(searchQuery);
      await searchInput.press('Enter');
    } else {
      await page.goto(`https://songselect.ccli.com/search/results?search=${encodeURIComponent(searchQuery)}&cat=all`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
    }
    
    await page.waitForTimeout(3000);
    
    // ── Step 2: Find the song ──────────────────────────────────
    console.log('   Looking for song...');
    
    const songResults = await page.locator('a[href*="/songs/"]').all();
    console.log('   Found', songResults.length, 'song links');
    
    let targetSong = null;
    
    for (const result of songResults) {
      const text = (await result.textContent() || '').trim();
      const lower = text.toLowerCase();
      
      let score = 0;
      
      if (author) {
        const titleMatch = lower.includes(query.toLowerCase().split(' ')[0]);
        const authorMatch = lower.includes(author.toLowerCase().split(' ')[0]);
        if (titleMatch && authorMatch) score = 10;
        else if (titleMatch) score = 5;
      } else {
        if (lower.includes(query.toLowerCase().split(' ')[0])) score = 5;
      }
      
      if (score > 0) {
        targetSong = result;
        break;
      }
    }
    
    // Fallback: first result
    if (!targetSong && songResults.length > 0) {
      targetSong = songResults[0];
    }
    
    if (!targetSong) {
      console.error('❌ No results found for your search.');
      process.exit(1);
    }
    
    // Click on the song
    console.log('   Opening song page...');
    const songLink = targetSong.locator('a[href*="/songs/"]').first();
    if (await songLink.count() > 0) {
      await songLink.click();
    } else {
      await targetSong.click();
    }
    
    await page.waitForTimeout(3000);
    console.log('   Song page loaded.');
    
    // ── Step 3: Get song info from page ────────────────────────
    console.log('   Extracting song info...');
    
    const songInfo = await page.evaluate(() => {
      const info = {};
      
      // Song number from URL
      const urlMatch = window.location.href.match(/\/songs\/(\d+)/);
      if (urlMatch) info.songNumber = urlMatch[1];
      
      // Transpose key from body text
      const bodyText = document.body.innerText;
      const keyMatch = bodyText.match(/(?:Default\s*Key|Transpose\s*Key)\s*[:\s]*([A-Gb#m]+)/i);
      if (keyMatch) info.transposeKey = keyMatch[1];
      
      return info;
    });
    
    const songNumber = songInfo.songNumber || ccliNum;
    // Use user-specified key if provided, otherwise extract from page
    const key = transposeKey || songInfo.transposeKey;
    
    if (!songNumber) {
      console.error('❌ Could not find song number on the page.');
      process.exit(1);
    }
    
    console.log(`   Song#: ${songNumber}, Key: ${key}`);
    
    // ── Step 4: Build the PDF URL ──────────────────────────────
    console.log('   Building PDF URL...');
    
    const pdfParams = new URLSearchParams({
      songNumber: songNumber,
      transposeKey: key,
      octave: '0',
      noteSize: '0',
      orientation: orientation,
      paperSize: paperSize,
      activityType: 'downloaded',
      renderer: 'pipeline',
    });
    
    const pdfUrl = `https://songselect.ccli.com/api/GetSongLeadPdf?${pdfParams.toString()}`;
    console.log(`   PDF URL: ${pdfUrl}`);
    
    // ── Step 5: Download the PDF ───────────────────────────────
    console.log('   Downloading...');
    
    const buffer = await fetchPdfViaHttp(pdfUrl, cookies);
    
    if (!buffer || buffer.length === 0) {
      console.error('❌ Failed to download PDF');
      process.exit(1);
    }
    
    if (downloadDir) {
      await savePdfToDisk(buffer, downloadDir, query, songNumber);
    } else {
      process.stdout.write(buffer);
      console.error('\n✅ (PDF sent to stdout)');
    }
    
  } finally {
    await browser.close();
  }
}

// ── Helpers ─────────────────────────────────────────────────────

async function fetchPdfViaHttp(pdfUrl, cookies) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(pdfUrl);
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/pdf,*/*',
        'Referer': 'https://songselect.ccli.com/',
      },
    };
    
    const req = transport.request(options, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        const redirectUrl = res.headers['location'];
        if (redirectUrl) {
          console.log('   Redirecting to:', redirectUrl);
          fetchPdfViaHttp(redirectUrl, cookies).then(resolve).catch(reject);
        } else {
          reject(new Error('Redirect without location header'));
        }
        return;
      }
      
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });
    
    req.on('error', e => reject(e));
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

// ── Helpers (continued) ─────────────────────────────────────────

async function savePdfToDisk(buffer, dir, query, songNumber) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  const safeQuery = (query || 'song').replace(/[^a-zA-Z0-9 ]/g, '').trim();
  const filename = `${safeQuery.replace(/\s+/g, '_')}_CCLI${songNumber}_leadsheet.pdf`;
  const filepath = join(dir, filename);
  
  writeFileSync(filepath, buffer);
  console.log(`\n✅ Saved to: ${filepath}`);
}

// ── Run ─────────────────────────────────────────────────────────
main().catch(err => {
  console.error(`\n❌ Error: ${err.message}`);
  if (!headless) console.error(err.stack);
  process.exit(1);
});
