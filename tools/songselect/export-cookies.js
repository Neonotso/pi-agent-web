#!/usr/bin/env node
/**
 * SongSelect Cookie Exporter
 * 
 * Opens Chrome → you log in → browser closes → cookies saved.
 * 
 * Usage: node export-cookies.js
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { join } from 'path';

const COOKIES_FILE = join(process.cwd(), 'cookies.json');

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  SONGSELECT COOKIE EXPORTER');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log('A browser window will open at songselect.ccli.com');
  console.log('');
  console.log('  STEP 1: Click "Sign In"');
  console.log('  STEP 2: Enter your CCLI/WordCloud credentials');
  console.log('  STEP 3: Complete 2FA if needed');
  console.log('  STEP 4: Navigate to any page (e.g., /songs)');
  console.log('  STEP 5: CLOSE THIS BROWSER WINDOW');
  console.log('');
  console.log('⚠️  Do NOT close the browser until you have logged in.');
  console.log('   The script will detect login and save cookies.');
  console.log('');

  const userDataDir = join(process.env.HOME, '.songselect-playwright-profile');
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    slowMo: 200,
  });

  const page = context.pages()[0] || (await context.newPage());

  // Navigate to SongSelect home
  await page.goto('https://songselect.ccli.com/', {
    waitUntil: 'networkidle',
    timeout: 20000,
  });

  console.log('🌐 Browser opened at songselect.ccli.com');
  console.log('   Waiting for you to log in...');
  console.log('');

  // Wait for browser to close OR for auth detection
  const startTime = Date.now();
  const timeoutMs = 15 * 60 * 1000; // 15 minutes

  while (Date.now() - startTime < timeoutMs) {
    // Check if browser context is still alive
    const pages = context.pages();
    if (pages.length === 0) {
      console.log('   Browser window closed.');
      break;
    }

    const currentPage = pages[0];

    // If no pages but context is open, create one
    if (!currentPage) {
      await context.newPage();
    }
    const url = currentPage.url();

    // Check if we're on a login page — wait for user
    if (url.includes('ccli.com/Account') || url.includes('cognito') || 
        url.includes('login') || url.includes('signin') || url.includes('sign-in')) {
      const waitMs = 5000 - ((Date.now() - startTime) % 5000);
      if (waitMs > 0) {
        console.log(`   ⏳ On login page... (check again in ${Math.ceil(waitMs / 1000)}s)`);
      }
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    // We're on a songselect page — check for post-login indicators
    if (url.includes('songselect.ccli.com')) {
      // Elements that ONLY appear after logging in:
      const checks = await Promise.allSettled([
        // User avatar / profile icon (appears in top right when logged in)
        currentPage.locator('[data-testid*="user"], [data-testid*="avatar"], .user-avatar, .profile-icon, img[src*="avatar"], img[src*="profile"]').first().isVisible().catch(() => false),
        // "Sign Out" link (only when logged in)
        currentPage.locator('a:has-text("Sign Out"), a:has-text("sign-out"), a:has-text("Sign out"), a:has-text("Sign off"), button:has-text("Sign Out")').first().isVisible().catch(() => false),
        // "Preferences" (usually only visible when logged in)
        currentPage.locator('a:has-text("Preferences"), a:has-text("Settings"), a:has-text("settings")').first().isVisible().catch(() => false),
      ]);

      const [hasAvatar, hasSignOut, hasPrefs] = checks.map(r => r.status === 'fulfilled' ? r.value : false);
      const hasAuth = hasSignOut || hasAvatar;

      if (hasAuth) {
        console.log(`   ✅ Authentication detected!`);
        if (hasSignOut) console.log('      - "Sign Out" link found');
        if (hasAvatar) console.log('      - User avatar found');
        console.log('   Saving cookies...');
        
        // Give a moment for any final redirect to complete
        await new Promise(r => setTimeout(r, 2000));
        
        // Extract and save cookies
        const cookies = await context.cookies();
        const relevantCookies = cookies.filter(c => 
          c.domain?.includes('ccli.com') || c.domain?.includes('songselect') ||
          c.domain?.includes('wordcloud')
        );
        
        writeFileSync(COOKIES_FILE, JSON.stringify(relevantCookies, null, 2));
        
        const hasAspNet = relevantCookies.some(c => 
          c.name?.includes('Cookie') || c.name?.includes('Auth') || 
          c.name?.includes('Identity') || c.name?.includes('Cognito')
        );
        
        await context.close();
        
        console.log('═══════════════════════════════════════════════════════');
        console.log(`  Saved ${relevantCookies.length} cookies → cookies.json`);
        console.log('═══════════════════════════════════════════════════════');
        console.log('');
        console.log(`  Auth cookies: ${hasAspNet ? '✅ Yes' : '⚠️  No (you may need to re-export)'}`);
        console.log('');
        if (!hasAspNet) {
          console.log('  ⚠️  No ASP.NET auth cookies found.');
          console.log('     If lead sheets don\'t work, extract cookies from');
          console.log('     your logged-in Chrome manually.');
        } else {
          console.log('  ✅ Ready to use!');
        }
        console.log('');
        return;
      }
    }

    // Keep checking
    await new Promise(r => setTimeout(r, 3000));
  }

  // Timeout - save whatever we have
  console.log('⏰ Timed out. Saving whatever cookies we have...');
  const cookies = await context.cookies();
  const relevantCookies = cookies.filter(c => 
    c.domain?.includes('ccli.com') || c.domain?.includes('songselect')
  );
  writeFileSync(COOKIES_FILE, JSON.stringify(relevantCookies, null, 2));
  await context.close();
  console.log(`Saved ${relevantCookies.length} cookies (may be incomplete)`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
