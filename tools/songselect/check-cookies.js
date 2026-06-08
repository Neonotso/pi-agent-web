#!/usr/bin/env node
/**
 * SongSelect Cookie Health Check
 * 
 * Tests if auth cookies are still valid by fetching a known lead sheet.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import https from 'https';

const COOKIES_FILE = join(process.cwd(), 'cookies.json');

async function main() {
  // Load cookies
  let cookies;
  try {
    cookies = JSON.parse(readFileSync(COOKIES_FILE, 'utf-8'));
  } catch (err) {
    console.error('❌ Cannot load cookies from', COOKIES_FILE);
    console.error('   Run: ./songselect.sh renew');
    process.exit(1);
  }
  
  // Check for required auth cookies
  const hasJwt = cookies.some(c => c.name === 'CCLI_JWT_AUTH');
  const hasNet = cookies.some(c => c.name === 'CCLI_NET_AUTH');
  
  if (!hasJwt && !hasNet) {
    console.log('❌ No auth cookies found in cookies.json');
    console.log('   Run: ./songselect.sh renew');
    process.exit(1);
  }
  
  console.log('Checking auth cookies...');
  console.log(`  CCLI_JWT_AUTH:  ${hasJwt ? '✅ Present' : '❌ Missing'}`);
  console.log(`  CCLI_NET_AUTH:  ${hasNet ? '✅ Present' : '⚠️  Missing (may still work)'}`);
  
  // Test by trying to fetch a PDF (quick, will fail if not auth'd)
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  
  const url = 'https://songselect.ccli.com/api/GetSongLeadPdf?songNumber=7117726&transposeKey=C&octave=0&noteSize=0&orientation=portrait&paperSize=Letter&activityType=downloaded&renderer=pipeline';
  const parsedUrl = new URL(url);
  
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'application/pdf,*/*',
    },
  };
  
  const result = await new Promise((resolve) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'],
          size: chunks.reduce((sum, c) => sum + c.length, 0),
        });
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
    req.end();
  });
  
  console.log('');
  
  if (result.status === 200 && result.contentType?.includes('pdf')) {
    console.log('✅ Cookies are VALID and working!');
    console.log(`   PDF response: ${result.size} bytes`);
    console.log('');
  } else {
    console.log('❌ Cookies are EXPIRED or INVALID!');
    console.log(`   Status: ${result.status} Content-Type: ${result.contentType}`);
    console.log('');
    console.log('   Run: ./songselect.sh renew');
    console.log('   Then log in when Chrome opens.');
    console.log('');
    process.exit(1);
  }
}

main();
