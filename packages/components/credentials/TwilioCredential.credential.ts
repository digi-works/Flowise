import { INodeParams, INodeCredential } from '../src/Interface'

class TwilioCredential implements INodeCredential {
    label: string
    name: string
    version: number
    description: string
    inputs: INodeParams[]

    constructor() {
        this.label = 'Twilio Credential'
        this.name = 'twilioCredential'
        this.version = 1.0
        this.description = 'Credential for authenticating with the Twilio REST API'

        this.inputs = [
            {
                label: 'Account SID',
                name: 'twilioAccountSid',
                type: 'string',
                description: 'Your Twilio Account SID (starts with AC)',
                placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
            },
            {
                label: 'Auth Token',
                name: 'twilioAuthToken',
                type: 'password',
                description: 'Your Twilio Auth Token',
                placeholder: 'your_auth_token_here'
            }
        ]
    }
}

module.exports = { credClass: TwilioCredential }
