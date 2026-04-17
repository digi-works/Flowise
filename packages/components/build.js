#!/usr/bin/env node
'use strict'

/**
 * SWC-based build script for flowise-components.
 * Replaces `tsc` to avoid TypeScript compiler OOM on large LangChain type graphs.
 * Uses @swc/core for transpilation (no type checking, just fast JS emit).
 */

const path = require('path')
const fs = require('fs')
const swc = require('@swc/core')

const SRC_DIRS = ['src', 'nodes', 'credentials']
const DIST_DIR = path.join(__dirname, 'dist')
const ROOT = __dirname

const SWC_OPTIONS = {
    jsc: {
        parser: {
            syntax: 'typescript',
            decorators: true,
            dynamicImport: true,
            tsx: false
        },
        target: 'es2020',
        transform: {
            legacyDecorator: true,
            decoratorMetadata: true
        },
        keepClassNames: true
    },
    module: {
        type: 'commonjs',
        noInterop: false
    },
    sourceMaps: true,
    isModule: true
}

function walkDir(dir, fileList = []) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '__tests__') {
                walkDir(fullPath, fileList)
            }
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            fileList.push(fullPath)
        }
    }
    return fileList
}

async function buildFile(srcFile) {
    const relPath = path.relative(ROOT, srcFile)
    const distFile = path.join(DIST_DIR, relPath.replace(/\.ts$/, '.js'))
    const mapFile = distFile + '.map'

    const dir = path.dirname(distFile)
    fs.mkdirSync(dir, { recursive: true })

    const options = {
        ...SWC_OPTIONS,
        filename: srcFile,
        sourceFileName: path.relative(path.dirname(distFile), srcFile)
    }

    const result = await swc.transformFile(srcFile, options)

    fs.writeFileSync(distFile, result.code)
    if (result.map) {
        fs.writeFileSync(mapFile, result.map)
    }
}

async function main() {
    const start = Date.now()
    console.log('Building flowise-components with SWC...')

    // Collect all .ts files
    const files = []
    for (const srcDir of SRC_DIRS) {
        const fullDir = path.join(ROOT, srcDir)
        if (fs.existsSync(fullDir)) {
            walkDir(fullDir, files)
        }
    }

    console.log(`Found ${files.length} TypeScript files`)

    // Build in parallel batches to avoid too many open files
    const BATCH_SIZE = 50
    let built = 0
    let errors = 0

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE)
        const results = await Promise.allSettled(batch.map(buildFile))
        for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'rejected') {
                console.error(`Error building ${path.relative(ROOT, batch[j])}: ${results[j].reason}`)
                errors++
            } else {
                built++
            }
        }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`Done: ${built} files compiled, ${errors} errors in ${elapsed}s`)

    if (errors > 0) {
        process.exit(1)
    }
}

main().catch((err) => {
    console.error('Build failed:', err)
    process.exit(1)
})
