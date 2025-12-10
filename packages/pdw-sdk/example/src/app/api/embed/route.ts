import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

export async function POST(request: NextRequest) {
  try {
    const { text } = await request.json();

    if (!text) {
      return NextResponse.json(
        { error: 'Missing required field: text' },
        { status: 400 }
      );
    }

    const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Gemini API key not configured' },
        { status: 500 }
      );
    }

    // Use GoogleGenAI directly (bypasses SDK import issues)
    const genAI = new GoogleGenAI({ apiKey });
    const startTime = Date.now();

    // Generate embedding using Gemini API
    const result = await genAI.models.embedContent({
      model: 'text-embedding-004',
      contents: text
    });

    const embedding = result.embeddings?.[0]?.values || [];
    const processingTime = Date.now() - startTime;

    return NextResponse.json({
      embedding,
      dimensions: embedding.length,
      model: 'text-embedding-004',
      processingTime,
    });
  } catch (error: any) {
    console.error('Embedding error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to generate embedding' },
      { status: 500 }
    );
  }
}
