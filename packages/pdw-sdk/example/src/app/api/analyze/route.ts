import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

export async function POST(request: NextRequest) {
  try {
    const { text, categories } = await request.json();

    if (!text || !categories) {
      return NextResponse.json(
        { error: 'Missing required fields: text, categories' },
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

    // Use Gemini to analyze the content
    const genAI = new GoogleGenAI({ apiKey });

    const prompt = `Analyze the following text and provide:
1. Category: Choose ONE from these categories: ${categories.join(', ')}
2. Importance: Score from 1-10 (1=trivial, 10=critical/life-changing)

Text: "${text}"

Respond in this exact JSON format:
{
  "category": "category_name",
  "importance": 5,
  "reason": "brief explanation"
}`;

    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });
    const responseText = (result.text || '').trim();

    // Parse JSON response
    let analysis;
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) ||
                       responseText.match(/\{[\s\S]*\}/);
      const jsonText = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : responseText;
      analysis = JSON.parse(jsonText);
    } catch (e) {
      console.error('Failed to parse AI response:', responseText);
      return NextResponse.json({
        category: 'personal',
        importance: 5,
        reason: 'Failed to parse AI response'
      });
    }

    // Validate category
    const validCategory = categories.find((cat: string) =>
      analysis.category.toLowerCase() === cat.toLowerCase()
    );

    // Validate importance (1-10)
    const importance = Math.max(1, Math.min(10, parseInt(analysis.importance) || 5));

    return NextResponse.json({
      category: validCategory || 'personal',
      importance: importance,
      reason: analysis.reason || 'AI analysis complete',
    });
  } catch (error: any) {
    console.error('Analysis error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to analyze content' },
      { status: 500 }
    );
  }
}
