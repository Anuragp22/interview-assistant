# Interview Assistant - AI-Powered Voice Interview Practice Platform

Interview Assistant is an advanced AI-powered interview practice platform that helps job seekers prepare for technical and behavioral interviews through realistic voice-based simulations using cutting-edge AI and voice technologies.

## About the Application

Interview Assistant creates a realistic interview environment by leveraging multiple AI services to simulate job interviews. The application allows users to practice their interview skills with an AI interviewer that can ask relevant questions based on job roles, experience levels, and technology stacks, providing comprehensive feedback after each session.

## Key Features

- **Personalized Interview Generation**: Create custom interview sessions based on job role, experience level, and specific technology stack
- **Real-time Voice Conversations**: Engage in natural voice conversations with an AI interviewer using advanced speech synthesis
- **Multiple Interview Types**: Practice technical interviews, behavioral interviews, or mixed format sessions
- **Comprehensive AI Feedback**: Receive detailed analysis and feedback on your interview performance using structured evaluation
- **Progress Tracking**: Monitor your improvement over time across different interview sessions
- **Tech Stack Visualization**: See technology icons for each interview type
- **Interview History**: Track all your past interviews and feedback

## Technology Stack

- **Frontend**: Next.js 15, React 19, Tailwind CSS 4
- **Backend**: Next.js API Routes, Server Actions
- **Database**: Firebase Firestore
- **Authentication**: Firebase Authentication with session cookies
- **Real-time transport**: LiveKit Cloud (WebRTC SFU) + LiveKit Agents (Python worker)
- **Speech-to-Text**: Deepgram Nova-2 (driven by the agent, not a hosted service)
- **Text-to-Speech**: 11labs "Sarah" voice (driven by the agent)
- **Conversation AI**: Groq Llama-3.3 70B (called via the OpenAI-compatible client; driven by the agent)
- **Feedback AI**: Google Gemini 2.0 Flash (server action, post-call)
- **UI Components**: Radix UI, Lucide React icons
- **Form Handling**: React Hook Form with Zod validation

## How the Voice Flow Works

The application uses **LiveKit Cloud** as the WebRTC SFU and a **Python agent** built on the LiveKit Agents SDK to run the AI pipeline:

1. **User clicks Call** → Next.js mints a LiveKit access token (signed JWT) with interview metadata.
2. **Browser joins the LiveKit room** → publishes microphone audio.
3. **LiveKit Cloud dispatches the Python agent** to the room as soon as the user appears.
4. **Inside the agent:** Deepgram transcribes user speech → Groq Llama-3.3 70B generates the interviewer's reply → 11labs converts the reply to Sarah's voice → audio is sent back through LiveKit.
5. **Per-turn:** the agent writes each completed exchange to `interviews/{id}/turns` in Firestore.
6. **End of call:** a server action reads the turns, asks Gemini 2.0 Flash to score the interview, and writes a `feedback/{id}` document.

## Getting Started

### Prerequisites

- Node.js 18+ and npm/yarn
- Python 3.11+ (for the LiveKit agent worker)
- Firebase account
- LiveKit Cloud account
- Groq API key (https://console.groq.com/keys)
- Deepgram API key
- ElevenLabs API key
- Google AI Studio account

### Environment Variables

To run this application successfully, you need to create a `.env.local` file in the root directory with the following variables:

```
# Firebase Configuration (Client)
NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_firebase_auth_domain
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_firebase_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_firebase_storage_bucket
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_firebase_messaging_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_firebase_app_id
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=your_firebase_measurement_id

# Firebase Configuration (Admin)
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_CLIENT_EMAIL=your_firebase_client_email
FIREBASE_PRIVATE_KEY=your_firebase_private_key

# Google Generative AI (Gemini) — used for question generation + post-call feedback
GOOGLE_GENERATIVE_AI_API_KEY=your_gemini_api_key

# LiveKit
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
NEXT_PUBLIC_LIVEKIT_URL=wss://your-project.livekit.cloud

# Optional: Analytics
NEXT_PUBLIC_ANALYTICS_ID=your_analytics_id
```

The Python agent under `livekit-agent/` has its own `.env` with provider keys — see `livekit-agent/README.md` for the full list (LiveKit credentials, Groq, Deepgram, ElevenLabs, and a Firebase service-account JSON for per-turn writes).

You can obtain these keys by:

1. Creating a Firebase project at [Firebase Console](https://console.firebase.google.com/)
2. Setting up a Google AI Studio account for the Gemini API key
3. Getting a Groq API key at [console.groq.com/keys](https://console.groq.com/keys)
4. Registering at [LiveKit Cloud](https://livekit.io/) for a project URL, API key, and secret
5. Creating accounts at [Deepgram](https://deepgram.com/) and [ElevenLabs](https://elevenlabs.io/) for the agent

### Running the Python agent

The voice pipeline runs in a separate Python service under `livekit-agent/`. See `livekit-agent/README.md` for setup. The Next.js app cannot conduct an interview on its own — both services must be running.

### Installation

1. Clone the repository

   ```bash
   git clone https://github.com/Anuragp22/interview-assistant
   cd interview-assistant
   ```

2. Install dependencies

   ```bash
   npm install
   # or
   yarn install
   ```

3. Create a `.env.local` file in the root directory with your API keys (see environment variables section above)

4. Start the development server

   ```bash
   npm run dev
   # or
   yarn dev
   ```

5. In a separate terminal, start the Python agent (see `livekit-agent/README.md`).

6. Navigate to `http://localhost:3000` to see the application.

## How to Use

1. **Create an Account**: Sign up with your email and password using Firebase Authentication
2. **Generate an Interview**: Use the interview generation form to create custom interviews with specific questions
3. **Start the Interview**: Begin the voice-based interview session with the AI interviewer
4. **Complete the Session**: Answer all questions to the best of your ability through voice conversation
5. **Review Feedback**: Receive detailed feedback on your performance with strengths and areas for improvement

## Features in Detail

### Interview Generation

- **Role Selection**: Choose from a variety of job roles (Frontend, Backend, Full Stack, etc.)
- **Experience Level**: Select Junior, Mid-level, or Senior
- **Tech Stack**: Specify the technologies relevant to the position
- **Interview Type**: Technical, Behavioral, or Mixed format
- **Question Count**: Customize the number of questions for your interview

### Voice Interaction

The application uses advanced speech-to-text and text-to-speech technologies to create a realistic interview environment:

- **Deepgram Nova-2**: Real-time speech recognition to capture your responses
- **11labs Sarah Voice**: Natural-sounding AI interviewer voice
- **Real-time Transcription**: See your responses transcribed as you speak
- **Contextual Understanding**: AI maintains conversation context throughout the interview

### Feedback Analysis

After each interview, receive comprehensive feedback including:

- **Overall Score**: Total performance score out of 100
- **Category Breakdown**: Scores in 5 key areas:
  - Communication Skills
  - Technical Knowledge
  - Problem Solving
  - Cultural Fit
  - Confidence and Clarity
- **Specific Strengths**: Identified areas of excellence
- **Areas for Improvement**: Actionable recommendations
- **Final Assessment**: Comprehensive summary of performance

### Technical Architecture

- **App Router**: Next.js 15 with app directory structure
- **Server Actions**: Server-side data mutations and API calls
- **Session Management**: Secure cookie-based authentication
- **Real-time Voice**: WebRTC via LiveKit Cloud, with a Python agent worker running the STT/LLM/TTS pipeline
- **Responsive Design**: Mobile-first design with Tailwind CSS
- **Type Safety**: Full TypeScript implementation with Zod validation

## Project Structure

```
interview-assistant/
├── app/
│   ├── (auth)/                    # Authentication pages
│   ├── (root)/                    # Main application pages
│   │   └── interview/             # Interview generation + live room + feedback
│   ├── api/interviews/generate/   # POST: Gemini → questions → Firestore
│   └── globals.css                # Global styles
├── components/                    # Shared React components (auth form, cards, icons)
├── lib/
│   ├── actions/                   # Server actions (auth, interview token, feedback)
│   ├── livekit.ts                 # LiveKit JWT minting helper
│   └── utils.ts                   # Utility functions
├── livekit-agent/                 # Python LiveKit Agents worker (separate service)
│   ├── src/interview_agent/       # Agent entrypoint, prompts, persistence
│   ├── pyproject.toml
│   └── README.md
├── firebase/                      # Firebase configuration (client + admin)
├── constants/                     # Application constants (tech-icon map, feedback schema)
└── types/                         # TypeScript type definitions (incl. types/livekit.d.ts)
```

## Voice Configuration

The AI interviewer uses the following voice configuration (now defined in Python — `livekit-agent/src/interview_agent/prompts.py` `voice_settings()`, not `constants/index.ts`):
- **Voice Provider**: 11labs
- **Voice ID**: Sarah (ElevenLabs voice ID `EXAVITQu4vr4xnSDxMaL`)
- **Stability**: 0.4 (balanced naturalness)
- **Similarity Boost**: 0.8 (consistent voice)
- **Speed**: 0.9 (slightly slower for clarity)
- **Style**: 0.5 (professional tone)
