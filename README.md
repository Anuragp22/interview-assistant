# JobVoice - AI-Powered Interview Assistant

JobVoice is an advanced AI-powered interview practice platform that helps job seekers prepare for technical and behavioral interviews through realistic voice-based simulations.

## About the Application

JobVoice creates a realistic interview environment by leveraging AI to simulate job interviews. The application allows users to practice their interview skills with an AI interviewer that can ask relevant questions based on job roles, experience levels, and technology stacks.

## Key Features

- **Personalized Interview Simulations**: Create custom interview sessions based on job role, experience level, and specific technology stack
- **Voice-Based Interactions**: Engage in natural voice conversations with the AI interviewer
- **Multiple Interview Types**: Practice technical interviews, behavioral interviews, or mixed format sessions
- **Comprehensive Feedback**: Receive detailed analysis and feedback on your interview performance
- **Progress Tracking**: Monitor your improvement over time across different interview sessions
- **Customizable Questions**: Generate relevant interview questions for your specific job target

## Technology Stack

- **Frontend**: Next.js, React, Tailwind CSS
- **Backend**: Next.js API Routes, Firebase Cloud Functions
- **Database**: Firebase Firestore
- **Authentication**: Firebase Authentication
- **AI Integration**: Google Generative AI, GPT-4
- **Voice Processing**: VAPI (Voice API) for realistic voice interactions

## Getting Started

### Prerequisites

- Node.js 16+ and npm/yarn
- Firebase account
- API keys for AI services

### Environment Variables

To run this application successfully, you need to create a `.env.local` file in the root directory with the following variables:

```
# Firebase Configuration
NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_firebase_auth_domain
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_firebase_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_firebase_storage_bucket
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_firebase_messaging_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_firebase_app_id

# Google Generative AI
GOOGLE_GENERATIVE_AI_API_KEY=your_gemini_api_key

# OpenAI for GPT-4
OPENAI_API_KEY=your_openai_api_key

# VAPI Voice API
VAPI_API_KEY=your_vapi_api_key
VAPI_PROJECT_ID=your_vapi_project_id

# Optional: Analytics
NEXT_PUBLIC_ANALYTICS_ID=your_analytics_id
```

You can obtain these keys by:

1. Creating a Firebase project at [Firebase Console](https://console.firebase.google.com/)
2. Setting up a Google AI Studio account for the Generative AI key
3. Creating an OpenAI account for the GPT-4 API key
4. Registering at VAPI for voice processing capabilities

A template `.env.example` file is included in the repository for reference.

### Installation

1. Clone the repository

   ```bash
   git clone https://github.com/yourusername/ai-interviewer.git
   cd ai-interviewer
   ```

2. Install dependencies

   ```bash
   npm install
   # or
   yarn install
   ```

3. Create a `.env.local` file in the root directory with your API keys (see `.env.example` for required variables)

4. Start the development server

   ```bash
   npm run dev
   # or
   yarn dev
   ```

5. Navigate to `http://localhost:3000` to see the application

## How to Use

1. **Create an Account**: Sign up with your email and password
2. **Configure an Interview**: Select your target role, experience level, and relevant tech stack
3. **Start the Interview**: Begin the voice-based interview session with the AI interviewer
4. **Complete the Session**: Answer all questions to the best of your ability
5. **Review Feedback**: Receive detailed feedback on your performance with strengths and areas for improvement

## Features in Detail

### Interview Configuration

- **Role Selection**: Choose from a variety of job roles (Frontend, Backend, Full Stack, etc.)
- **Experience Level**: Select Junior, Mid-level, or Senior
- **Tech Stack**: Specify the technologies relevant to the position
- **Interview Type**: Technical, Behavioral, or Mixed format

### Voice Interaction

The application uses advanced speech-to-text and text-to-speech technologies to create a realistic interview environment:

- Natural-sounding AI interviewer voice
- Real-time speech recognition to capture your responses
- Contextual understanding of your answers

### Feedback Analysis

After each interview, receive comprehensive feedback including:

- Overall score
- Performance in key categories (Technical Knowledge, Communication Skills, Problem Solving, etc.)
- Specific strengths identified
- Areas for improvement with actionable recommendations
- Final assessment summary
