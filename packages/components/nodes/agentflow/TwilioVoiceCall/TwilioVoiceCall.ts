import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { getCredentialData, getCredentialParam } from '../../../src/utils'
import { updateFlowState } from '../utils'
import { ConversationRelaySessionManager } from './TwilioConversationRelay'
import { v4 as uuidv4 } from 'uuid'
import fetch from 'node-fetch'
import * as http from 'http'
import * as net from 'net'

function urlEncode(params: Record<string, string>): string {
    return Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
}

// ─── Module-level shared mini-server ─────────────────────────────────────────
// One HTTP+WebSocket server is created on first use and shared across all calls.
// It lives for the lifetime of the Flowise process.
// Keyed by sessionId.

interface PendingSession {
    manager: ConversationRelaySessionManager
    twiml: string
}

const pendingSessions = new Map<string, PendingSession>()

let sharedServer: http.Server | null = null
let sharedServerPort: number | null = null
let sharedWss: any = null // ws.Server

async function getOrCreateSharedServer(): Promise<{ server: http.Server; port: number; wss: any }> {
    if (sharedServer && sharedServerPort && sharedWss) {
        return { server: sharedServer, port: sharedServerPort, wss: sharedWss }
    }

    const WebSocket = (await import('ws')).default

    // Find a free port starting from 3001
    const port = await findFreePort(3001)

    const server = http.createServer((req, res) => {
        const url = req.url || ''

        // Match /twiml/<sessionId>
        const twimlMatch = url.match(/^\/twiml\/([^/?]+)/)
        if (twimlMatch) {
            const sessionId = twimlMatch[1]
            const pending = pendingSessions.get(sessionId)
            if (!pending) {
                res.writeHead(404)
                res.end('Session not found')
                return
            }
            console.log(`[TwilioVoiceCall] TwiML served for session ${sessionId}`)
            res.writeHead(200, { 'Content-Type': 'text/xml' })
            res.end(pending.twiml)
            return
        }
        const recordingMatch = url.match(/^\/recordings\/([^/?]+)$/)
        if (recordingMatch) {
            const filename = recordingMatch[1]
            const fs = require('fs')
            const path = require('path')
            const filepath = path.join(process.cwd(), 'public', 'recordings', filename)

            console.log(`[TwilioVoiceCall] Recording request for: ${filename}`)

            if (fs.existsSync(filepath)) {
                const stat = fs.statSync(filepath)
                res.writeHead(200, {
                    'Content-Type': 'audio/mpeg',
                    'Content-Length': stat.size,
                    'Accept-Ranges': 'bytes'
                })
                const fileStream = fs.createReadStream(filepath)
                fileStream.pipe(res)
                console.log(`[TwilioVoiceCall] ✅ Served recording: ${filename} (${stat.size} bytes)`)
                return
            } else {
                console.log(`[TwilioVoiceCall] ❌ Recording not found: ${filepath}`)
                res.writeHead(404)
                res.end('Recording not found')
                return
            }
        }

        res.writeHead(200)
        res.end('Twilio Voice Bridge OK')
    })

    const wss = new WebSocket.Server({ noServer: true })

    // WebSocket upgrade — match /ws/<sessionId>
    server.on('upgrade', (request, socket, head) => {
        const url = request.url || ''
        const wsMatch = url.match(/^\/ws\/([^/?]+)/)
        if (!wsMatch) {
            socket.destroy()
            return
        }

        const sessionId = wsMatch[1]
        const pending = pendingSessions.get(sessionId)
        if (!pending) {
            console.error(`[TwilioVoiceCall] WebSocket upgrade: no session for ${sessionId}`)
            socket.destroy()
            return
        }

        wss.handleUpgrade(request, socket, head, (ws: any) => {
            wss.emit('connection', ws, request)
            const { manager } = pending

            console.log(`[TwilioVoiceCall] WebSocket connected for session ${sessionId}`)

            ws.on('message', (raw: Buffer | string) => {
                try {
                    const message = JSON.parse(raw.toString())
                    // Twilio sends messages with a "type" field, not "event"
                    const msgType = message.type || message.event
                    switch (msgType) {
                        case 'setup':
                            manager.onSetup(sessionId, ws, message)
                            break
                        case 'prompt':
                            manager.onPrompt(sessionId, message)
                            break
                        case 'interrupt':
                            manager.onInterrupt(sessionId)
                            break
                        case 'error':
                            manager.onError(sessionId, message)
                            break
                        default:
                            console.warn(`[ConversationRelay] unknown type: ${msgType}`, JSON.stringify(message))
                    }
                } catch (e) {
                    console.error('[ConversationRelay] failed to parse WS message:', e)
                }
            })

            ws.on('close', () => {
                manager.onClose(sessionId)
                pendingSessions.delete(sessionId)
            })

            ws.on('error', (err: any) => {
                console.error(`[ConversationRelay] [${sessionId}] ws error:`, err)
                manager.onClose(sessionId)
                pendingSessions.delete(sessionId)
            })
        })
    })

    await new Promise<void>((resolve, reject) => {
        server.listen(port, '0.0.0.0', () => {
            console.log(`[TwilioVoiceCall] Mini bridge server started on port ${port}`)
            resolve()
        })
        server.on('error', reject)
    })

    sharedServer = server
    sharedServerPort = port
    sharedWss = wss

    return { server, port, wss }
}

function findFreePort(startPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const tryPort = (port: number) => {
            const server = net.createServer()
            server.listen(port, '0.0.0.0', () => {
                server.close(() => resolve(port))
            })
            server.on('error', () => {
                if (port < 65535) tryPort(port + 1)
                else reject(new Error('No free port found'))
            })
        }
        tryPort(startPort)
    })
}

async function getCallRecordings(accountSid: string, authToken: string, callSid: string, maxRetries = 5): Promise<any[]> {
    const recordingsUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}/Recordings.json`

    // Retry logic to wait for recording to be ready
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const response = await fetch(recordingsUrl, {
            headers: {
                Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64')
            }
        })

        if (!response.ok) {
            throw new Error(`Failed to fetch recordings: ${response.status}`)
        }

        const data = (await response.json()) as Record<string, any>
        const recordings = data.recordings || []

        // Check if recordings exist and are ready
        if (recordings.length > 0) {
            const recording = recordings[0]
            if (recording.status === 'completed') {
                console.log(`[TwilioVoiceCall] Recording ready after ${attempt + 1} attempt(s)`)
                return recordings
            }
            console.log(`[TwilioVoiceCall] Recording status: ${recording.status}, waiting...`)
        } else {
            console.log(`[TwilioVoiceCall] No recordings found yet, attempt ${attempt + 1}/${maxRetries}`)
        }

        // Wait before retrying (exponential backoff)
        if (attempt < maxRetries - 1) {
            await new Promise((resolve) => setTimeout(resolve, 2000 + attempt * 1000))
        }
    }

    // Return whatever we have after max retries
    const response = await fetch(recordingsUrl, {
        headers: {
            Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64')
        }
    })
    const data = (await response.json()) as Record<string, any>
    return data.recordings || []
}

// Helper function to download recording from Twilio and save to public storage
// This provides a publicly accessible URL without Twilio authentication
async function downloadAndStoreRecording(accountSid: string, authToken: string, recording: any, publicBaseUrl: string): Promise<string> {
    try {
        const recordingSid = recording.sid
        const recordingUri = recording.uri

        // Check if recording is ready
        if (recording.status !== 'completed') {
            console.log(`[TwilioVoiceCall] Recording not ready yet (status: ${recording.status}), returning Twilio URL`)
            // Return the Twilio media_url which can be accessed with auth
            return recording.media_url || `https://api.twilio.com${recordingUri.replace('.json', '.mp3')}`
        }

        // Download the recording from Twilio using media_url
        const downloadUrl = recording.media_url || `https://api.twilio.com${recordingUri.replace('.json', '.mp3')}`
        console.log('[TwilioVoiceCall] Downloading recording from Twilio:', downloadUrl)

        const response = await fetch(downloadUrl, {
            headers: {
                Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64')
            }
        })

        if (!response.ok) {
            console.log(`[TwilioVoiceCall] Failed to download recording: ${response.status}, returning Twilio URL`)
            return recording.media_url || `https://api.twilio.com${recordingUri.replace('.json', '.mp3')}`
        }

        const buffer = Buffer.from(await response.arrayBuffer())
        console.log('[TwilioVoiceCall] Downloaded recording, size:', buffer.length, 'bytes')

        // Save to a public directory (adjust path based on your Flowise setup)
        const fs = await import('fs')
        const path = await import('path')

        // Create recordings directory if it doesn't exist
        // This should be in your public/static files directory
        const recordingsDir = path.join(process.cwd(), 'public', 'recordings')
        if (!fs.existsSync(recordingsDir)) {
            fs.mkdirSync(recordingsDir, { recursive: true })
        }

        // Save file with recording SID as filename
        const filename = `${recordingSid}.mp3`
        const filepath = path.join(recordingsDir, filename)
        fs.writeFileSync(filepath, new Uint8Array(buffer))

        // Generate public URL
        const publicUrl = `${publicBaseUrl}/recordings/${filename}`
        console.log('[TwilioVoiceCall] ✅ Recording saved and accessible at:', publicUrl)

        return publicUrl
    } catch (error) {
        console.error('[TwilioVoiceCall] Error downloading and storing recording:', error)
        // Fallback to Twilio media URL
        return recording.media_url || `https://api.twilio.com${recording.uri.replace('.json', '.mp3')}`
    }
}

// ─────────────────────────────────────────────────────────────────────────────

class TwilioVoiceCall_AgentFlows implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    color: string
    baseClasses: string[]
    documentation?: string
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'Twilio Voice Call'
        this.name = 'twilioVoiceCall'
        this.version = 2.0
        this.type = 'Action'
        this.category = 'Agent Flows'
        this.icon = 'twilioVoiceCall.svg'
        this.description =
            'Make an outbound phone call and hold a real-time AI conversation ' +
            'with the caller using Twilio ConversationRelay and any Chat Model ' +
            'available in your Digiworks instance.'
        this.color = '#F22F46'
        this.baseClasses = [this.type]

        this.credential = {
            label: 'Twilio Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['twilioCredential'],
            description: 'Twilio Account SID and Auth Token'
        }

        this.inputs = [
            {
                label: 'Twilio Number',
                name: 'twilioFromNumber',
                type: 'string',
                description: 'Your Twilio phone number (the "From" number) in E.164 format.',
                placeholder: '+15551234567',
                acceptVariable: true
            },
            {
                label: 'To Call Numbers',
                name: 'twilioToNumber',
                type: 'string',
                description: 'The phone number(s) to trigger call to, in E.164 format. Comma-separated for multiple.',
                placeholder: '+15559876543',
                acceptVariable: true
            },

            // --- Chat Model ------------------------------------------
            {
                label: 'Chat Model',
                name: 'twilioLLMModel',
                type: 'asyncOptions',
                loadMethod: 'listModels',
                loadConfig: true,
                description: 'Chat Model for prompting — powers the dynamic call response (like VAPI assistant).'
            },

            // --- System Prompt ---------------------------------------
            {
                label: 'System Prompt',
                name: 'twilioSystemPrompt',
                type: 'string',
                description:
                    'Prompt like in VAPI assistant for dynamic call response. ' +
                    'Example: "You are a friendly customer-support agent. Answer questions briefly."',
                rows: 8,
                acceptVariable: true,
                placeholder: 'You are a helpful voice assistant. Keep replies short and conversational.'
            },

            // --- Welcome Greeting ------------------------------------
            {
                label: 'Welcome Greeting',
                name: 'twilioWelcomeGreeting',
                type: 'string',
                description: 'The first thing the AI says when the call connects.',
                placeholder: 'Hello! How can I help you today?',
                acceptVariable: true,
                optional: true
            },

            // --- Enable Transcript -----------------------------------
            {
                label: 'Enable Transcript',
                name: 'twilioEnableTranscript',
                type: 'boolean',
                description: 'If enabled, the full call transcript will be returned after the call ends.',
                default: true
            },
            {
                label: 'Enable Recording',
                name: 'enableRecording',
                type: 'boolean',
                optional: true,
                default: true,
                description: 'Record the phone call (default: true)'
            },

            // --- Advanced settings -----------------------------------
            {
                label: 'TTS Provider',
                name: 'twilioTTSProvider',
                type: 'options',
                description: 'Text-to-Speech provider (default: ElevenLabs).',
                options: [
                    { label: 'ElevenLabs (highest quality)', name: 'elevenlabs' },
                    { label: 'Google', name: 'google' },
                    { label: 'Amazon Polly', name: 'amazon' }
                ],
                default: 'elevenlabs',
                optional: true
            },
            {
                label: 'TTS Voice',
                name: 'twilioTTSVoice',
                type: 'string',
                description: 'Voice ID for the TTS provider (leave empty for default).',
                placeholder: 'e.g. NYC9WEgkq1u4jiqBseQ9 (ElevenLabs)',
                optional: true
            },
            {
                label: 'STT Provider',
                name: 'twilioSTTProvider',
                type: 'options',
                description: 'Speech-to-Text provider (default: Google).',
                options: [
                    { label: 'Google', name: 'google' },
                    { label: 'Deepgram', name: 'deepgram' }
                ],
                default: 'google',
                optional: true
            },
            {
                label: 'Language',
                name: 'twilioLanguage',
                type: 'options',
                description: 'Primary language for the call.',
                options: [
                    { label: 'English (US)', name: 'en-US' },
                    { label: 'English (GB)', name: 'en-GB' },
                    { label: 'Spanish (ES)', name: 'es-ES' },
                    { label: 'French (FR)', name: 'fr-FR' },
                    { label: 'German (DE)', name: 'de-DE' },
                    { label: 'Portuguese (BR)', name: 'pt-BR' }
                ],
                default: 'en-US',
                optional: true
            },
            {
                label: 'Max Call Duration (seconds)',
                name: 'twilioMaxDuration',
                type: 'number',
                description: 'The AI will end the call after this many seconds.',
                default: 300,
                optional: true
            },
            {
                label: 'Public Base URL',
                name: 'publicBaseUrl',
                type: 'string',
                description: 'The public URL where Twilio can reach your server',
                placeholder: 'https://your-domain.com or https://xxxx.ngrok.io',
                optional: false,
                acceptVariable: true
            },

            // --- Update Flow State -----------------------------------
            {
                label: 'Update Flow State',
                name: 'twilioUpdateState',
                description: 'Update runtime state during the execution of the workflow',
                type: 'array',
                optional: true,
                acceptVariable: true,
                array: [
                    {
                        label: 'Key',
                        name: 'key',
                        type: 'asyncOptions',
                        loadMethod: 'listRuntimeStateKeys',
                        freeSolo: true
                    },
                    {
                        label: 'Value',
                        name: 'value',
                        type: 'string',
                        acceptVariable: true,
                        acceptNodeOutputAsVariable: true
                    }
                ]
            }
        ]
    }

    //@ts-ignore
    loadMethods = {
        async listModels(_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> {
            const componentNodes = options.componentNodes as { [key: string]: INode }
            const returnOptions: INodeOptionsValue[] = []

            for (const nodeName in componentNodes) {
                const componentNode = componentNodes[nodeName]
                if (componentNode.category === 'Chat Models') {
                    if (componentNode.tags?.includes('LlamaIndex')) continue
                    returnOptions.push({
                        label: componentNode.label,
                        name: nodeName,
                        imageSrc: componentNode.icon
                    })
                }
            }
            return returnOptions
        },
        async listRuntimeStateKeys(_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> {
            const previousNodes = options.previousNodes as ICommonObject[]
            const startAgentflowNode = previousNodes.find((node) => node.name === 'startAgentflow')
            const state = startAgentflowNode?.inputs?.startState as ICommonObject[]
            return state?.map((item) => ({ label: item.key, name: item.key })) || []
        }
    }

    async run(nodeData: INodeData, _input: string | Record<string, any>, options: ICommonObject): Promise<any> {
        // ------------------------------------------------------------------
        // 1.  Credentials
        // ------------------------------------------------------------------
        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const accountSid = getCredentialParam('twilioAccountSid', credentialData, nodeData)
        const authToken = getCredentialParam('twilioAuthToken', credentialData, nodeData)

        if (!accountSid || !authToken) {
            throw new Error('Twilio credential is missing. Please configure Account SID and Auth Token.')
        }

        // ------------------------------------------------------------------
        // 2.  Read inputs
        // ------------------------------------------------------------------
        const fromNumber = (nodeData.inputs?.twilioFromNumber as string)?.trim()
        const toNumber = (nodeData.inputs?.twilioToNumber as string)?.trim()
        const systemPrompt =
            (nodeData.inputs?.twilioSystemPrompt as string)?.trim() ||
            'You are a helpful voice assistant. Keep replies short and conversational.'
        const welcomeGreeting = (nodeData.inputs?.twilioWelcomeGreeting as string)?.trim() || 'Hello! How can I help you today?'
        const ttsProvider = (nodeData.inputs?.twilioTTSProvider as string) || 'elevenlabs'
        const ttsVoice = (nodeData.inputs?.twilioTTSVoice as string)?.trim() || ''
        const sttProvider = (nodeData.inputs?.twilioSTTProvider as string) || 'google'
        const language = (nodeData.inputs?.twilioLanguage as string) || 'en-US'
        const maxDuration = (nodeData.inputs?.twilioMaxDuration as number) || 300
        const publicBaseUrl = (nodeData.inputs?.publicBaseUrl as string)?.trim() || ''
        const enableRecording = nodeData.inputs?.enableRecording !== false // FIX: was twilioEnableRecording
        const enableTranscript = nodeData.inputs?.twilioEnableTranscript !== false

        console.log('[TwilioVoiceCall] enableRecording from inputs:', nodeData.inputs?.enableRecording)
        console.log('[TwilioVoiceCall] enableRecording final value:', enableRecording)

        if (!fromNumber) throw new Error('"Twilio Number" is required.')
        if (!toNumber) throw new Error('"To Call Numbers" is required.')
        if (!publicBaseUrl) throw new Error('"Public Base URL" is required. Paste your public URL here.')

        // ------------------------------------------------------------------
        // 3.  Load the LLM
        // ------------------------------------------------------------------
        const selectedModel = nodeData.inputs?.twilioLLMModel as string
        const selectedModelConfig = nodeData.inputs?.twilioLLMModelConfig as ICommonObject

        if (!selectedModel) throw new Error('A Chat Model must be selected.')

        const modelInstanceFilePath = (options.componentNodes as any)[selectedModel].filePath as string
        const modelModule = await import(modelInstanceFilePath)
        const newModelInstance = new modelModule.nodeClass()
        // Debug: show what keys are in selectedModelConfig so we can confirm credential passing
        console.log('[TwilioVoiceCall] selectedModelConfig keys:', Object.keys(selectedModelConfig || {}))

        const modelNodeData = {
            ...nodeData,
            // Pass the credential ID stored in the model config so Flowise
            // can look up the API key from its credential store
            credential:
                selectedModelConfig?.['FLOWISE_CREDENTIAL_ID'] ||
                selectedModelConfig?.['DIGIWORKS_CREDENTIAL_ID'] ||
                selectedModelConfig?.['credential'] ||
                nodeData.credential,
            inputs: { ...nodeData.inputs, ...selectedModelConfig }
        }
        const llmModel = await newModelInstance.init(modelNodeData, '', options)

        // ------------------------------------------------------------------
        // 4.  Start (or reuse) the shared mini bridge server
        // ------------------------------------------------------------------
        const { port } = await getOrCreateSharedServer()

        // Normalise base URL — strip trailing slash
        const baseUrl = publicBaseUrl.replace(/\/+$/, '')

        // ------------------------------------------------------------------
        // 5.  Create session
        // ------------------------------------------------------------------
        const sessionId = uuidv4()
        const manager = new ConversationRelaySessionManager()

        manager.createSession(sessionId, {
            systemPrompt,
            welcomeGreeting,
            maxDurationSeconds: maxDuration,
            llmModel
        })

        // ------------------------------------------------------------------
        // 6.  Build TwiML
        // ------------------------------------------------------------------
        const twimlUrl = `${baseUrl}/twiml/${sessionId}`
        const wsUrl = `${baseUrl.replace(/^https?:\/\//, 'wss://')}/ws/${sessionId}`

        let crAttrs = `url="${wsUrl}" welcomeGreeting="${welcomeGreeting}"`
        crAttrs += ` ttsProvider="${ttsProvider}"`
        crAttrs += ` transcriptionProvider="${sttProvider}"`
        crAttrs += ` language="${language}"`
        if (ttsVoice) crAttrs += ` voice="${ttsVoice}"`

        const twiml = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Response>',
            '  <Connect>',
            `    <ConversationRelay ${crAttrs} />`,
            '  </Connect>',
            '</Response>'
        ].join('\n')

        // Register in pending map so server handlers can find it
        pendingSessions.set(sessionId, { manager, twiml })

        console.log(`[TwilioVoiceCall] ── Bridge server port : ${port}`)
        console.log(`[TwilioVoiceCall] ── TwiML URL          : ${twimlUrl}`)
        console.log(`[TwilioVoiceCall] ── WebSocket URL      : ${wsUrl}`)
        console.log(`[TwilioVoiceCall] ── Session ID         : ${sessionId}`)
        console.log(`[TwilioVoiceCall] ── ACTION NEEDED: make sure ngrok is tunnelling port ${port}`)

        // Safety cleanup timer (5 min) in case call never connects
        const cleanupTimer = setTimeout(() => {
            pendingSessions.delete(sessionId)
            manager.removeSession(sessionId)
            console.warn(`[TwilioVoiceCall] Session ${sessionId} timed out`)
        }, 5 * 60 * 1000)

        // ------------------------------------------------------------------
        // 7.  Initiate outbound call via Twilio REST API
        // ------------------------------------------------------------------
        const callApiUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`
        const callBody: Record<string, string> = {
            From: fromNumber,
            To: toNumber,
            Url: twimlUrl,
            Method: 'GET',
            Record: enableRecording ? 'true' : 'false'
        }

        console.log('[TwilioVoiceCall] Call API body:', JSON.stringify(callBody, null, 2))

        const callResponse = await fetch(callApiUrl, {
            method: 'POST',
            headers: {
                Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: urlEncode(callBody)
        })

        const callResponseText = await callResponse.text()
        let callJson: Record<string, any>
        try {
            callJson = JSON.parse(callResponseText)
        } catch (_) {
            clearTimeout(cleanupTimer)
            pendingSessions.delete(sessionId)
            manager.removeSession(sessionId)
            throw new Error(`Twilio API returned non-JSON (${callResponse.status}): ${callResponseText}`)
        }

        if (!callResponse.ok) {
            clearTimeout(cleanupTimer)
            pendingSessions.delete(sessionId)
            manager.removeSession(sessionId)
            throw new Error(`Twilio call failed ${callJson.code || callResponse.status}: ${callJson.message || callResponseText}`)
        }

        const callSid = callJson.sid
        console.log(`[TwilioVoiceCall] Call initiated — SID: ${callSid}, status: ${callJson.status}`)

        // ------------------------------------------------------------------
        // 8.  Wait for call to finish WITH TIMEOUT for unanswered calls
        //     If the callee doesn't pick up, Twilio won't open the WebSocket
        //     but the status callback will fire. We need a timeout to prevent
        //     hanging forever waiting for a WebSocket that will never connect.
        // ------------------------------------------------------------------
        console.log('[TwilioVoiceCall] Waiting for call to end...')

        // Poll Twilio call status to detect unanswered/busy/failed calls
        let callCompleted = false
        const statusCheckInterval = setInterval(async () => {
            if (callCompleted) {
                clearInterval(statusCheckInterval)
                return
            }

            try {
                const statusUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`
                const statusResponse = await fetch(statusUrl, {
                    headers: {
                        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64')
                    }
                })

                if (statusResponse.ok) {
                    const callStatus = await statusResponse.json()
                    console.log(`[TwilioVoiceCall] Call status: ${callStatus.status}`)

                    // Check if call ended without WebSocket connection (unanswered, busy, etc)
                    if (['busy', 'no-answer', 'failed', 'canceled', 'completed'].includes(callStatus.status)) {
                        clearInterval(statusCheckInterval)
                        callCompleted = true

                        // If completed but no transcript, it means call wasn't answered
                        const sess = manager.getSession(sessionId)
                        if (callStatus.status !== 'completed' || !sess?.transcript?.length) {
                            console.log(`[TwilioVoiceCall] Call ${callStatus.status} without answer - forcing end`)
                            manager.endSession(sessionId, `Call ${callStatus.status}`)
                        }
                    }
                }
            } catch (err) {
                console.error('[TwilioVoiceCall] Error polling call status:', err)
            }
        }, 3000) // Poll every 3 seconds

        // Wait for session to end (either via WebSocket close or forced by polling above)
        const endedSession = await manager.waitForEnd(sessionId)

        clearInterval(statusCheckInterval)
        clearTimeout(cleanupTimer)

        let finalCallStatus = 'completed'
        try {
            const statusUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`
            const statusResponse = await fetch(statusUrl, {
                headers: {
                    Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64')
                }
            })
            if (statusResponse.ok) {
                const statusJson = (await statusResponse.json()) as Record<string, any>
                finalCallStatus = statusJson.status || 'completed'
                console.log(`[TwilioVoiceCall] Final call status from Twilio: ${finalCallStatus}`)
            }
        } catch (err) {
            console.error('[TwilioVoiceCall] Could not fetch final call status:', err)
        }

        let recordings: any[] = []
        let recordingUrl = ''

        console.log('[TwilioVoiceCall] ===== RECORDING FETCH DEBUG =====')
        console.log('[TwilioVoiceCall] enableRecording:', enableRecording)
        console.log('[TwilioVoiceCall] callSid:', callSid)

        if (enableRecording) {
            try {
                console.log('[TwilioVoiceCall] Fetching recordings from Twilio API (with retry logic)...')
                recordings = await getCallRecordings(accountSid, authToken, callSid)
                console.log(`[TwilioVoiceCall] Found ${recordings.length} recording(s)`)
                console.log('[TwilioVoiceCall] Recordings array:', JSON.stringify(recordings, null, 2))

                if (recordings.length > 0) {
                    const recording = recordings[0]

                    // Download from Twilio and save to public directory for client access
                    console.log('[TwilioVoiceCall] Processing recording for public access...')
                    recordingUrl = await downloadAndStoreRecording(accountSid, authToken, recording, publicBaseUrl)
                    console.log('[TwilioVoiceCall] ✅ Public recording URL:', recordingUrl)

                    recordings.forEach((rec, idx) => {
                        console.log(`[TwilioVoiceCall] Recording ${idx + 1}:`, {
                            sid: rec.sid,
                            status: rec.status,
                            duration: rec.duration,
                            mediaUrl: rec.media_url
                        })
                    })
                } else {
                    console.log('[TwilioVoiceCall] ⚠️ No recordings found - recordingUrl will be empty')
                }
            } catch (err) {
                console.error('[TwilioVoiceCall] ❌ Error fetching recordings:', err)
            }
        } else {
            console.log('[TwilioVoiceCall] Recording is DISABLED - skipping fetch')
        }

        console.log('[TwilioVoiceCall] Final recordingUrl value:', recordingUrl)
        console.log('[TwilioVoiceCall] =====================================')

        console.log('[TwilioVoiceCall] Call ended. endedSession:', !!endedSession)
        console.log('[TwilioVoiceCall] Transcript entries:', endedSession?.transcript?.length || 0)

        // ------------------------------------------------------------------
        // 9.  Build result & update flow state
        // ------------------------------------------------------------------
        const durationSec = endedSession ? Math.round((Date.now() - endedSession.startedAt) / 1000) : 0

        const transcriptFormatted =
            endedSession?.transcript.map((t) => `[${t.role === 'caller' ? 'Caller' : 'Agent'}]: ${t.text}`).join('\n') || ''

        console.log('[TwilioVoiceCall] transcriptFormatted length:', transcriptFormatted.length)
        console.log('[TwilioVoiceCall] transcriptFormatted preview:', transcriptFormatted.substring(0, 200))

        // Update flow state if needed
        const state = (options.agentflowRuntime?.state as ICommonObject) || {}
        let newState = { ...state }
        const _twilioUpdateState = nodeData.inputs?.twilioUpdateState

        if (_twilioUpdateState && Array.isArray(_twilioUpdateState) && _twilioUpdateState.length > 0) {
            newState = updateFlowState(state, _twilioUpdateState)
        }

        // Process template variables in state
        if (newState && Object.keys(newState).length > 0) {
            for (const key in newState) {
                const stateValue = newState[key]?.toString() || ''
                if (stateValue.includes('{{ output')) {
                    // Handle simple output replacement
                    if (stateValue === '{{ output }}') {
                        newState[key] = transcriptFormatted
                        continue
                    }

                    // Handle JSON path expressions like {{ output.callSid }}
                    const match = stateValue.match(/\{\{\s*output\.(\w+)\s*\}\}/)
                    if (match) {
                        const outputMap: Record<string, any> = {
                            callSid: callSid,
                            callTranscript: transcriptFormatted,
                            callDuration: String(durationSec),
                            callStatus: finalCallStatus,
                            callRecordingUrl: recordingUrl || ''
                        }

                        const outputKey = match[1]
                        newState[key] = outputMap[outputKey] !== undefined ? outputMap[outputKey] : stateValue
                    }
                }
            }
        }

        pendingSessions.delete(sessionId)
        manager.removeSession(sessionId)

        // Build the output object in Flowise's expected format
        const formattedOutput = [
            `callSid: ${callSid}`,
            `callTranscript: ${transcriptFormatted || 'No transcript available'}`,
            `callDuration: ${String(durationSec)}`,
            `callStatus: ${finalCallStatus}`,
            `callRecordingUrl: ${recordingUrl || 'Not available'}`
        ].join('\n')
        const output: Record<string, any> = {
            content: formattedOutput,
            // Store individual fields for programmatic access if needed
            callSid,
            callStatus: finalCallStatus,
            callDuration: String(durationSec),
            callRecordingUrl: recordingUrl || '',
            callTranscript: transcriptFormatted || 'No transcript available',
            timeMetadata: {
                start: endedSession?.startedAt || Date.now(),
                end: Date.now(),
                delta: durationSec * 1000 // milliseconds
            }
        }

        if (enableTranscript && endedSession?.transcript) {
            output.rawTranscript = endedSession.transcript
        }
        if (enableRecording && recordings.length > 0) {
            const recording = recordings[0] // Use the first recording
            output.recording = {
                sid: recording.sid,
                duration: recording.duration,
                url: recordingUrl, // Public URL (already processed by downloadAndStoreRecording)
                twilioApiUrl: `https://api.twilio.com${recording.uri.replace('.json', '.mp3')}`, // Original Twilio URL
                allRecordings: recordings.map((rec) => ({
                    sid: rec.sid,
                    duration: rec.duration,
                    dateCreated: rec.date_created
                }))
            }
        }

        // Return in Flowise's expected structure
        return {
            id: nodeData.id,
            name: this.name,
            input: {
                from: fromNumber,
                to: toNumber,
                systemPrompt: systemPrompt.substring(0, 100) + '...',
                welcomeGreeting
            },
            output,
            state: newState
        }
    }
}

module.exports = { nodeClass: TwilioVoiceCall_AgentFlows }
