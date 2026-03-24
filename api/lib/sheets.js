const { google } = require('googleapis');

/**
 * Helper to manage Google Sheets operations for the AI Assistant.
 */
class GoogleSheetsHelper {
  constructor(auth) {
    this.sheets = google.sheets({ version: 'v4', auth });
    this.drive = google.drive({ version: 'v3', auth });
  }

  /**
   * Finds or creates the default spreadsheet "AI Assistant - Tasks & Notes".
   * Returns the spreadsheetId.
   */
  async getOrCreateSpreadsheet(redisClient) {
    const REDIS_KEY = 'system:google_sheet_id';
    
    // Check Redis first
    let spreadsheetId = await redisClient.get(REDIS_KEY);
    if (spreadsheetId) return spreadsheetId;

    // Search Drive for the file
    const response = await this.drive.files.list({
      q: "name = 'AI Assistant - Tasks & Notes' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    if (response.data.files && response.data.files.length > 0) {
      spreadsheetId = response.data.files[0].id;
      await redisClient.set(REDIS_KEY, spreadsheetId);
      return spreadsheetId;
    }

    // Create a new one
    const resource = {
      properties: {
        title: 'AI Assistant - Tasks & Notes',
      },
    };
    const spreadsheet = await this.sheets.spreadsheets.create({
      resource,
      fields: 'spreadsheetId',
    });

    spreadsheetId = spreadsheet.data.spreadsheetId;

    // Initialize Headers
    await this.sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Sheet1!A1:G1',
      valueInputOption: 'RAW',
      resource: {
        values: [['Timestamp', 'Original Text', 'Refined Content', 'Category', 'Tasks', 'Calendar Link', 'Status']],
      },
    });

    await redisClient.set(REDIS_KEY, spreadsheetId);
    return spreadsheetId;
  }

  /**
   * Appends a new confirmed note/task row to the spreadsheet.
   */
  async appendRow(spreadsheetId, data) {
    const { timestamp, original, refined, category, tasks, calendarLink } = data;
    const values = [
      [
        timestamp,
        original,
        refined,
        category || 'Uncategorized',
        tasks || '',
        calendarLink || '',
        'New'
      ]
    ];

    await this.sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet1!A:A',
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });
  }
}

module.exports = { GoogleSheetsHelper };
