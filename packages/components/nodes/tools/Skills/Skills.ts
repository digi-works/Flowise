import { StructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'
import { getBaseClasses } from '../../../src/utils'
import { getFileFromStorage } from '../../../src/storageUtils'

interface SkillData {
    name: string
    description: string
    tags: string[]
    body: string
}

/**
 * Parse YAML-ish frontmatter from a SKILL.md string.
 * Supports: key: value, key: "quoted value", key: [list, items]
 * Falls back to body-only if no frontmatter found.
 */
function parseSkillMd(raw: string): SkillData {
    const result: SkillData = { name: '', description: '', tags: [], body: '' }

    const lines = raw.split('\n')
    if (lines.length < 2 || lines[0].trim() !== '---') {
        // No frontmatter — treat entire content as body
        result.body = raw.trim()
        return result
    }

    let inFrontmatter = true
    let bodyLines: string[] = []
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]
        if (inFrontmatter && line.trim() === '---') {
            inFrontmatter = false
            continue
        }
        if (inFrontmatter) {
            const colonIdx = line.indexOf(':')
            if (colonIdx > 0) {
                const key = line.slice(0, colonIdx).trim().toLowerCase()
                let value = line.slice(colonIdx + 1).trim()
                // Strip quotes
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1)
                }
                // Handle arrays: [item1, item2]
                if (value.startsWith('[') && value.endsWith(']')) {
                    const items = value
                        .slice(1, -1)
                        .split(',')
                        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
                    if (key === 'tags' || key === 'tag') {
                        result.tags = items
                    } else if (key === 'name') {
                        result.name = items[0] || ''
                    } else if (key === 'description' || key === 'desc') {
                        result.description = items[0] || ''
                    }
                } else {
                    if (key === 'name') result.name = value
                    else if (key === 'description' || key === 'desc') result.description = value
                    else if (key === 'tags' || key === 'tag') result.tags = [value]
                }
            }
        } else {
            bodyLines.push(line)
        }
    }

    result.body = bodyLines.join('\n').trim()
    return result
}

class Skills_Tools implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs: INodeParams[]

    constructor() {
        this.label = 'Skills'
        this.name = 'skills'
        this.version = 1.0
        this.type = 'Skills'
        this.icon = 'skills.svg'
        this.category = 'Tools'
        this.description = 'Import or paste a SKILL.md file and use it as a tool in your agent flow'
        this.baseClasses = [this.type, 'Tool', ...getBaseClasses(SkillsTool)]

        this.inputs = [
            {
                label: 'Import SKILL.md File',
                name: 'skillFile',
                type: 'file',
                description: 'Upload a SKILL.md file to import its instructions as a reusable skill',
                fileType: '.md,.txt',
                optional: true
            },
            {
                label: 'Or Paste SKILL.md Content',
                name: 'skillContent',
                type: 'code',
                description: 'Paste the full SKILL.md content here (including YAML frontmatter). Used when no file is uploaded.',
                placeholder: `---\nname: my-skill\ndescription: What this skill does\ntags: [tag1, tag2]\n---\n\n# Skill Instructions\n\n1. First do this\n2. Then do that`,
                rows: 12,
                optional: true
            },
            {
                label: 'Return Direct',
                name: 'returnDirect',
                type: 'boolean',
                description: 'Return the skill output directly to the user (bypasses the LLM)',
                optional: true
            },
            {
                label: 'Skill Name (override)',
                name: 'skillName',
                type: 'string',
                description: 'Override the name from the SKILL.md frontmatter. Leave blank to use the parsed name.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Skill Description (override)',
                name: 'skillDescription',
                type: 'string',
                description: 'Override the description from the SKILL.md frontmatter. Leave blank to use the parsed description.',
                rows: 3,
                optional: true,
                additionalParams: true
            }
        ]
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const skillFile = nodeData.inputs?.skillFile as string
        const skillContent = nodeData.inputs?.skillContent as string
        const returnDirect = nodeData.inputs?.returnDirect as boolean
        const nameOverride = nodeData.inputs?.skillName as string
        const descOverride = nodeData.inputs?.skillDescription as string

        // Resolve raw content: file upload takes priority
        let rawContent = ''
        if (skillFile) {
            try {
                const orgId = options.orgId
                const chatflowid = options.chatflowid

                // File input comes as "FILE-STORAGE::filename" or as data URI
                let filename = skillFile
                const FILE_STORAGE_PREFIX = 'FILE-STORAGE::'
                if (filename.startsWith(FILE_STORAGE_PREFIX)) {
                    filename = filename.replace(FILE_STORAGE_PREFIX, '')
                }

                // If it looks like a JSON array of files, take the first one
                if (filename.startsWith('[') && filename.endsWith(']')) {
                    const files = JSON.parse(filename)
                    filename = files[0]
                }

                // If it's a data URI (base64), decode it directly
                if (filename.startsWith('data:')) {
                    const base64Match = filename.match(/^data:.*;base64,(.*)$/)
                    if (base64Match) {
                        const buffer = Buffer.from(base64Match[1], 'base64')
                        rawContent = buffer.toString('utf-8')
                    }
                } else {
                    // Otherwise read from storage
                    const fileData = await getFileFromStorage(filename, orgId, chatflowid)
                    rawContent = Buffer.from(fileData as unknown as ArrayBuffer).toString('utf-8')
                }
            } catch (e) {
                throw new Error(`Failed to read uploaded SKILL.md file: ${(e as Error).message}`)
            }
        } else if (skillContent) {
            rawContent = skillContent
        } else {
            throw new Error('Please either upload a SKILL.md file or paste the content.')
        }

        // Parse frontmatter + body
        const parsed = parseSkillMd(rawContent)

        const toolName = nameOverride || parsed.name || 'skill'
        const toolDescription = descOverride || parsed.description || 'A reusable skill with instructions for the agent to follow.'

        return new SkillsTool({
            name: toolName,
            description: toolDescription,
            tags: parsed.tags,
            body: parsed.body,
            returnDirect
        })
    }
}

interface SkillsToolParams {
    name: string
    description: string
    tags: string[]
    body: string
    returnDirect: boolean
}

class SkillsTool extends StructuredTool {
    static lc_name() {
        return 'SkillsTool'
    }

    name: string
    description: string
    tags: string[]
    body: string
    returnDirect: boolean

    schema = z.object({
        skill_request: z
            .string()
            .describe(
                'The specific task or question to execute using this skill. Leave empty if the skill provides context-only instructions.'
            )
    }) as any

    constructor({ name, description, tags, body, returnDirect }: SkillsToolParams) {
        super()
        this.name = name
        this.description = description
        this.tags = tags
        this.body = body
        this.returnDirect = returnDirect ?? false
    }

    async _call({ skill_request }: z.infer<typeof this.schema>): Promise<string> {
        // Return the full skill context to the LLM
        const output = [
            `# Skill: ${this.name}`,
            `Description: ${this.description}`,
            this.tags.length > 0 ? `Tags: ${this.tags.join(', ')}` : '',
            '',
            '## Instructions',
            this.body,
            '',
            skill_request ? `## Task\n${skill_request}` : ''
        ]
            .filter(Boolean)
            .join('\n')

        return output
    }
}

module.exports = { nodeClass: Skills_Tools }
