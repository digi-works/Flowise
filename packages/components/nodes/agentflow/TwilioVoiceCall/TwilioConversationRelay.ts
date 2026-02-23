import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages'

export interface SessionConfig {
    systemPrompt: string
    welcomeGreeting: string
    maxDurationSeconds: number
    llmModel: BaseChatModel
}

export interface ActiveSession {
    config: SessionConfig
    ws: any // the raw WebSocket instance
    callSid: string | null
    conversationHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    transcript: Array<{ role: 'caller' | 'agent'; text: string; timestamp: number }>
    startedAt: number
    ended: boolean
    resolveEndPromise: (() => void) | null
    endPromise: Promise<void>
}

export class ConversationRelaySessionManager {
    private sessions = new Map<string, ActiveSession>()
    createSession(sessionId: string, config: SessionConfig): ActiveSession {
        let resolveEndPromise: () => void
        const endPromise = new Promise<void>((resolve) => {
            resolveEndPromise = resolve
        })

        const session: ActiveSession = {
            config,
            ws: null,
            callSid: null,
            conversationHistory: [{ role: 'system', content: config.systemPrompt }],
            transcript: [],
            startedAt: Date.now(),
            ended: false,
            resolveEndPromise: resolveEndPromise!,
            endPromise
        }

        this.sessions.set(sessionId, session)
        return session
    }

    getSession(sessionId: string): ActiveSession | undefined {
        return this.sessions.get(sessionId)
    }

    removeSession(sessionId: string) {
        this.sessions.delete(sessionId)
    }

    onSetup(sessionId: string, ws: any, message: any) {
        const session = this.sessions.get(sessionId)
        if (!session) {
            console.warn(`[ConversationRelay] setup received for unknown session ${sessionId}`)
            return
        }

        session.ws = ws
        session.callSid = message.callSid || null

        console.log(`[ConversationRelay] session ${sessionId} set up — callSid: ${session.callSid}`)
    }

    // ------------------------------------------------------------------
    // Called when the caller speaks and ConversationRelay sends "prompt"
    // ------------------------------------------------------------------
    async onPrompt(sessionId: string, message: any) {
        const session = this.sessions.get(sessionId)
        if (!session || session.ended) return

        // Debug: log the raw message so we can see exact field names from Twilio
        console.log(`[ConversationRelay] [${sessionId}] raw prompt message:`, JSON.stringify(message))

        // Twilio ConversationRelay sends the caller's speech in "voicePrompt" field
        // Fall back to "transcript" for compatibility with older versions
        const callerText: string = (message.voicePrompt || message.transcript || '').trim()
        if (!callerText) return

        // Guard: max duration
        const elapsedSec = (Date.now() - session.startedAt) / 1000
        if (elapsedSec > session.config.maxDurationSeconds) {
            this.endSession(sessionId, 'Max call duration reached.')
            return
        }

        // --- record caller utterance ----------------------------------
        session.conversationHistory.push({ role: 'user', content: callerText })
        session.transcript.push({ role: 'caller', text: callerText, timestamp: Date.now() })

        console.log(`[ConversationRelay] [${sessionId}] caller: "${callerText}"`)

        // --- stream LLM response --------------------------------------
        try {
            // Build LangChain message array from history
            const lcMessages = session.conversationHistory.map((m) => {
                if (m.role === 'system') return new SystemMessage(m.content)
                if (m.role === 'user') return new HumanMessage(m.content)
                return new AIMessage(m.content) // assistant
            })

            let fullReply = ''

            // Use .stream() — supported by all BaseChatModel subclasses in LangChain
            const stream = await session.config.llmModel.stream(lcMessages)

            for await (const chunk of stream) {
                const token = typeof chunk.content === 'string' ? chunk.content : ''
                if (!token) continue

                fullReply += token

                // Check if session was interrupted mid-stream
                if (session.ended) return

                // Send token to Twilio — last: false while streaming
                this.sendText(session, token, false)
            }

            // --- stream finished; mark last token -----------------------
            // Send an empty final token with last:true to tell ConversationRelay
            // "that's the end of this turn".  Twilio docs say the final token
            // should carry last:true; content can be empty string.
            this.sendText(session, '', true)

            // --- record assistant utterance ------------------------------
            session.conversationHistory.push({ role: 'assistant', content: fullReply })
            session.transcript.push({ role: 'agent', text: fullReply, timestamp: Date.now() })

            console.log(`[ConversationRelay] [${sessionId}] agent: "${fullReply}"`)

            // --- check if agent wants to end the call --------------------
            // Method 1: Look for end signals in the response text
            const endPhrases = [
                'have a great day!',
                '[END_CALL]', // explicit marker agents can use
                'goodbye and have a great day'
            ]

            const lowerReply = fullReply.toLowerCase()
            const shouldEndCall = endPhrases.some((phrase) => lowerReply.includes(phrase.toLowerCase()))

            if (shouldEndCall) {
                console.log(`[ConversationRelay] [${sessionId}] agent signaled end of call via phrase`)
                // Wait a moment for TTS to finish, then end
                setTimeout(() => {
                    if (!session.ended) {
                        this.endSession(sessionId, 'Agent ended the call')
                    }
                }, 2000) // 2 second delay to let the goodbye message play
            }
        } catch (err) {
            console.error(`[ConversationRelay] [${sessionId}] LLM error:`, err)
            // Tell the caller something went wrong, then keep the session alive
            this.sendText(session, 'Sorry, I encountered an error. Please try again.', true)
        }
    }

    // ------------------------------------------------------------------
    // Called when the caller interrupts mid-speech
    // ------------------------------------------------------------------
    onInterrupt(sessionId: string) {
        const session = this.sessions.get(sessionId)
        if (!session) return
        console.log(`[ConversationRelay] [${sessionId}] caller interrupted`)
        // Nothing we need to explicitly do — the LLM stream loop will
        // check session.ended on each iteration.  ConversationRelay
        // itself stops TTS playback on interrupt automatically.
    }

    // ------------------------------------------------------------------
    // Called when Twilio reports an error
    // ------------------------------------------------------------------
    onError(sessionId: string, message: any) {
        console.error(`[ConversationRelay] [${sessionId}] error from Twilio:`, message)
    }

    // ------------------------------------------------------------------
    // Called when WebSocket closes (call ended / disconnected)
    // ------------------------------------------------------------------
    onClose(sessionId: string) {
        const session = this.sessions.get(sessionId)
        if (!session) return

        if (!session.ended) {
            session.ended = true
            if (session.resolveEndPromise) session.resolveEndPromise()
        }

        console.log(`[ConversationRelay] [${sessionId}] WebSocket closed`)
    }

    // ------------------------------------------------------------------
    // Programmatically end the session (e.g. max duration)
    // ------------------------------------------------------------------
    endSession(sessionId: string, reason?: string) {
        const session = this.sessions.get(sessionId)
        if (!session || session.ended) return

        session.ended = true

        // Send end event to Twilio
        try {
            if (session.ws && session.ws.readyState === 1 /* OPEN */) {
                session.ws.send(
                    JSON.stringify({
                        type: 'end',
                        handoffData: JSON.stringify({ reason: reason || 'Session ended' })
                    })
                )
            }
        } catch (_) {
            /* ignore send errors on close */
        }

        if (session.resolveEndPromise) session.resolveEndPromise()
    }

    // ------------------------------------------------------------------
    // Wait for a session to finish (used by node.run to block until done)
    // ------------------------------------------------------------------
    async waitForEnd(sessionId: string): Promise<ActiveSession | null> {
        const session = this.sessions.get(sessionId)
        if (!session) return null
        await session.endPromise
        return session
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private sendText(session: ActiveSession, text: string, last: boolean) {
        if (!session.ws) return
        try {
            if (session.ws.readyState === 1) {
                session.ws.send(JSON.stringify({ type: 'text', token: text, last }))
            }
        } catch (err) {
            console.error('[ConversationRelay] sendText error:', err)
        }
    }
}
