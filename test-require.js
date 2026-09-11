const fs = require('fs');
const path = require('path');

try {
  const m = require('./routes/checkin');
  console.log('checkin.js loaded OK');
} catch (e) {
  console.log('ERROR loading checkin.js:');
  console.log(e.message);
  console.log(e.stack);
}
