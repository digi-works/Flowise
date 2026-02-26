const express = require('express')
const path = require('path')

app.use('/recordings', express.static(path.join(__dirname, 'public', 'recordings')))
