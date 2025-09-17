# Maveli Runner Backend

## Overview

This is the backend server for the Maveli Runner endless runner game. It provides RESTful APIs for user authentication, secure high-score submissions, and leaderboard retrieval using Node.js, Express.js, and Supabase.

## Features

- API endpoints for authentication, scores, and leaderboard
- Supabase Auth (JWT) integration
- PostgreSQL + Row-Level Security for fair, secure storage
- Production-ready configuration with `.env` secrets

## Setup

1. **Clone the repository:**
    ```
    git clone https://github.com/tkmfoss/maveli-runner-server.git
    cd maveli-runner/Maveli_Game_Server
    ```

2. **Install dependencies:**
    ```
    npm install
    ```

3. **Environment variables:**
    Add a `.env` file:
    ```
    SUPABASE_URL=your_supabase_url
    SUPABASE_KEY=your_supabase_anon_key
    ```

4. **Run locally:**
    ```
    npm run dev
    # or npm start
    ```
    By default, the API runs on http://localhost:5000

## BACKEND_FOLDER STRUCTURE
```
backend/
├── node_modules/
├── routes/
│   ├── game.js
│   ├── auth.js              
├── package.json
├── package-lock.json
├── .env
├── vercel.json
└── server.js
```

## API Endpoints (examples)

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/scoreupdate`
- `GET /api/leaderboard`

## Deployment

Deployable on Vercel, Render, Railway, or similar Node hosts. Set environment variables in your platform’s dashboard.

---
