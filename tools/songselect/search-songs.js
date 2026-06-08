#!/usr/bin/env node
/**
 * SongSelect Song Search
 * 
 * Searches SongSelect for songs and returns JSON results.
 * 
 * Usage:
 *   node search-songs.js "Goodness Of God"
 *   node search-songs.js "Goodness Of God" --artist "Ed Cash"
 *   node search-songs.js --ccli 7117726
 *
 * Output: JSON array of { title, artist, ccli, key, ... }
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { join } from 'path';

const COOKIES_FILE = join(process.cwd(), 'cookies.json');

// ── Argument parsing ──────────────────────────────────────────────────
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

const query = args.find(a => !a.startsWith('--'));
const artist = getArg(['--artist']);
const ccli = getArg(['--ccli']);

if (!query && !ccli) {
  console.error('Usage: node search-songs.js "Song Title" [--artist "Artist"] [--ccli 123456]');
  process.exit(1);
}

// ── Cookie loading ────────────────────────────────────────────────────
async function loadCookies() {
  try {
    const raw = readFileSync(COOKIES_FILE, 'utf-8');
    const cookies = JSON.parse(raw);
    if (!cookies.some(c => c.name === 'CCLI_JWT_AUTH')) {
      console.error('❌ No CCLI_JWT_AUTH cookie found!');
      process.exit(1);
    }
    return cookies;
  } catch (err) {
    console.error('❌ Cannot load cookies:', err.message);
    process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  const cookies = await loadCookies();

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
  });

  try {
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();

    // Navigate to SongSelect
    await page.goto('https://songselect.ccli.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // Search
    const searchQuery = ccli ? `CCLI ${ccli}` : query;
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

    // Wait for results to render
    await page.waitForTimeout(4000);

    // Extract song results
    const results = await page.evaluate(() => {
      const items = [];
      const songLinks = document.querySelectorAll('a[href*="/songs/"]');
      
      for (const link of songLinks) {
        const href = link.getAttribute('href') || '';
        const text = (link.textContent || '').trim();
        const parent = link.closest('[data-testid="song-result"]') || link.closest('[class*="result"]') || link.closest('[class*="song"]') || link;
        
        // Try to extract individual fields
        let title = '';
        let artist = '';
        let ccli = '';
        
        // Get text content from parent/container
        const parentText = parent.textContent || '';
        
        // Extract CCLI number
        const ccliMatch = text.match(/#?(\d{6,7})/);
        if (ccliMatch) ccli = ccliMatch[1];
        
        // Extract key
        const keyMatch = text.match(/Key:\s*([A-Gb#m]+)/i);
        const keyMatch2 = text.match(/Key\s*(\d)/);
        if (keyMatch) {
          title = keyMatch[0].replace(/Key:\s*/i, '');
        }
        
        // Try to get structured data from the page
        const container = link.closest('li') || link.closest('div') || link.parentElement;
        const containerText = container?.textContent || '';
        
        items.push({
          raw: text.substring(0, 200),
          containerText: containerText.substring(0, 300),
          href,
          ccli: ccli || '',
        });
      }
      
      return items;
    });

    // If we got raw results, try to parse them better
    let parsedResults;
    if (results.length > 0 && results[0].raw) {
      // Extract structured info from raw text
      parsedResults = results.map((r, i) => {
        // Try to parse from the raw text or container text
        const raw = r.raw || '';
        const container = r.containerText || '';
        const text = raw || container;
        
        // Extract CCLI number
        const ccliMatch = text.match(/#?(\d{6,7})/);
        const ccli = ccliMatch ? ccliMatch[1] : r.ccli;
        
        // Extract title (first part before "by" or ":" or artist)
        let title = '';
        let artistName = '';
        const byMatch = text.match(/(.+?)\s+by\s+(.+)/i);
        const colonMatch = text.match(/(.+?)\s*[:—–]\s*(.+)/);
        
        if (byMatch) {
          title = byMatch[1].trim();
          artistName = byMatch[2].trim();
        } else if (colonMatch) {
          title = colonMatch[1].trim();
          artistName = colonMatch[2].trim();
        } else {
          // Just take a portion of the text as title
          title = text.substring(0, 60).trim();
        }
        
        return {
          title: title || `Song ${i + 1}`,
          artist: artistName || 'Unknown',
          ccli: ccli || 'Unknown',
          raw: text,
        };
      });
    } else {
      parsedResults = results;
    }

    console.log(JSON.stringify(parsedResults, null, 2));
  } catch (err) {
    console.error(`❌ Error: ${err.message}`, process.stderr);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
