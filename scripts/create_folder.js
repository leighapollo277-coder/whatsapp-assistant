const { google } = require('googleapis');
const fs = require('fs');
const envPath = '/Users/kenneth/.gemini/antigravity/scratch/whatsapp-assistant/.env';

function parseEnv(path) {
  const content = fs.readFileSync(path, 'utf8');
  const env = {};
  content.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      env[match[1].trim()] = match[2].trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    }
  });
  return env;
}

async function main() {
  const env = parseEnv(envPath);
  const { GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = env;
  
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
      console.error("Missing credentials in .env");
      return;
  }

  let formattedKey = GOOGLE_PRIVATE_KEY.includes('\\n') ? GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : GOOGLE_PRIVATE_KEY;
  if (!formattedKey.includes('-----BEGIN PRIVATE KEY-----')) {
    formattedKey = `-----BEGIN PRIVATE KEY-----\n${formattedKey}\n-----END PRIVATE KEY-----`;
  }
  
  const auth = new google.auth.JWT({ 
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL, 
    key: formattedKey, 
    scopes: ['https://www.googleapis.com/auth/drive'] 
  });
  
  const drive = google.drive({ version: 'v3', auth });
  
  const folderMetadata = {
    name: 'WhatsApp Assistant Photos Backup',
    mimeType: 'application/vnd.google-apps.folder',
  };
  
  try {
    console.log("Creating folder...");
    const folder = await drive.files.create({
      resource: folderMetadata,
      fields: 'id, webViewLink'
    });
    
    const folderId = folder.data.id;
    const viewLink = folder.data.webViewLink;
    
    console.log("Setting permissions...");
    // Make it editable by anyone with the link so you can view it without logging into the service account
    await drive.permissions.create({
      fileId: folderId,
      requestBody: {
        role: 'writer',
        type: 'anyone'
      }
    });

    console.log(`\n✅ Folder Created Successfully!`);
    console.log(`Folder ID: ${folderId}`);
    console.log(`Access Link: ${viewLink}`);

    // Update .env
    let envContent = fs.readFileSync(envPath, 'utf8');
    if (envContent.includes('GOOGLE_DRIVE_FOLDER_ID=')) {
        envContent = envContent.replace(/GOOGLE_DRIVE_FOLDER_ID=.*/g, `GOOGLE_DRIVE_FOLDER_ID=${folderId}`);
    } else {
        envContent += `\nGOOGLE_DRIVE_FOLDER_ID=${folderId}\n`;
    }
    fs.writeFileSync(envPath, envContent);
    console.log("✅ .env file updated with GOOGLE_DRIVE_FOLDER_ID");

    // Also update vercel environment
    console.log("To deploy to vercel, we should also push this new env variable. (Please run vercel env add GOOGLE_DRIVE_FOLDER_ID manually)");

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
