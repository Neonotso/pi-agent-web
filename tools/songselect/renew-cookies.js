#!/usr/bin/env node
/**
 * SongSelect Cookie Renew
 * 
 * Launches Chrome with remote debugging, opens SongSelect,
 * you log in, then the script captures your auth cookies.
 * 
 * Usage: node renew-cookies.js
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const COOKIES_FILE = join(process.cwd(), 'cookies.json');
const CHROME_DEBUG_PORT = 9222;

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  SONGSELECT COOKIE RENEW');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log('This will launch Chrome with remote debugging enabled.');
  console.log('');
  console.log('  1. Chrome opens at songselect.ccli.com');
  console.log('  2. Log in with your CCLI/WordCloud credentials');
  console.log('  3. Navigate to any page (e.g., click "Home")');
  console.log('  4. The script detects login and captures cookies');
  console.log('');
  console.log('⚠️  You must log in. The script needs your auth cookie.');
  console.log('');

  // Launch Chrome with remote debugging
  console.log('Starting Chrome with debug port...' );
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  // Navigate to SongSelect
  await page.goto('https://songselect.ccli.com/', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  console.log('🌐 Browser opened. Please sign in.');
  console.log('');

  // Wait for authentication by monitoring for auth cookies
  let authFound = false;
  const startTime = Date.now();
  const timeoutMs = 15 * 60 * 1000; // 15 minutes

  while (!authFound && Date.now() - startTime < timeoutMs) {
    if (context.pages().length === 0) {
      console.log('   Browser closed before login detected.');
      break;
    }

    // Get all cookies
    const cookies = await context.cookies();
    
    // Check for auth cookies
    const jwtAuth = cookies.find(c => c.name === 'CCLI_JWT_AUTH');
    const netAuth = cookies.find(c => c.name === 'CCLI_NET_AUTH');
    
    if (jwtAuth || netAuth) {
      authFound = true;
      console.log('   ✅ Authentication detected!');
      if (jwtAuth) console.log('      - CCLI_JWT_AUTH found');
      if (netAuth) console.log('      - CCLI_NET_AUTH found');
      break;
    }

    // Check for any .AspNetCookies or Auth cookies
    const authCookie = cookies.find(c => 
      c.name.includes('Cookie') || c.name.includes('Auth') || 
      c.name.includes('Identity') || c.name.includes('Cognito')
    );
    
    if (authCookie) {
      authFound = true;
      console.log('   ✅ Auth cookie found:', authCookie.name);
      break;
    }

    // Also check by navigating to a private page to see if logged in
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const hasLibrary = bodyText.includes('Your Library');
    const hasUpgrade = bodyText.includes('Upgrade');
    
    if (hasLibrary && !bodyText.includes('Sign In')) {
      // Look for auth cookies specifically
      const hasJwt = cookies.some(c => c.name.includes('JWT') || c.name.includes('jwt'));
      if (hasJwt) {
        authFound = true;
        console.log('   ✅ Auth JWT detected on page!');
        break;
      }
    }

    await new Promise(r => setTimeout(r, 3000));
  }

  if (!authFound) {
    console.log('');
    console.log('⚠️  No auth cookies detected.');
    console.log('   You may need to log in more explicitly.');
  }

  // Save ALL SongSelect-relevant cookies
  const cookies = await context.cookies();
  const relevantCookies = cookies.filter(c => 
    c.domain?.includes('ccli.com') || c.domain?.includes('songselect')
  );
  
  writeFileSync(COOKIES_FILE, JSON.stringify(relevantCookies, null, 2));
  
  await browser.close();

  // Report what we saved
  const hasJwt = relevantCookies.some(c => c.name === 'CCLI_JWT_AUTH');
  const hasNet = relevantCookies.some(c => c.name === 'CCLI_NET_AUTH');
  const hasAspNet = relevantCookies.some(c => c.name.includes('Cookie') || c.name.includes('Auth'));
  
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  SAVED ${relevantCookies.length} cookies → cookies.json`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log(`  CCLI_JWT_AUTH:    ${hasJwt ? '✅ Yes' : '❌ No'}`);
  console.log(`  CCLI_NET_AUTH:    ${hasNet ? '✅ Yes' : '❌ No'}`);
  console.log(`  Other Auth:       ${hasAspNet ? '✅ Yes' : '❌ No'}`);
  console.log('');
  
  if (hasJwt) {
    console.log('  ✅ Ready! You can now fetch lead sheets.');
    console.log('');
    console.log('  Try: node fetch-leadsheet.js "Goodness Of God"');
    console.log('');
  } else {
    console.log('  ⚠️  No JWT auth cookie found.');
    console.log('     If lead sheets don\'t work, you may need to:');
    console.log('     1. Make sure you actually logged in');
    console.log('     2. Wait a few seconds after logging in');
    console.log('     3. Try running again');
    console.log('');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
