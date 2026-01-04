/**
 * Test endpoint for pdw.analytics namespace
 *
 * Usage:
 * curl -X GET "http://localhost:3000/api/test/analytics?walletAddress=YOUR_WALLET"
 * curl -X GET "http://localhost:3000/api/test/analytics?walletAddress=YOUR_WALLET&method=categories"
 * curl -X GET "http://localhost:3000/api/test/analytics?walletAddress=YOUR_WALLET&method=importance"
 */
import { NextRequest, NextResponse } from 'next/server';
import { getReadOnlyPDWClient } from '@/lib/pdw-read-only';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DUMMY_WALLET = '0x0000000000000000000000000000000000000000000000000000000000000000';

export async function GET(request: NextRequest) {
  const walletAddress = request.nextUrl.searchParams.get('walletAddress');
  const method = request.nextUrl.searchParams.get('method') || 'generate';

  try {
    console.log(`[TEST] analytics.${method}() - wallet: ${walletAddress || 'dummy'}`);

    const pdw = await getReadOnlyPDWClient(walletAddress || DUMMY_WALLET);

    let result: any;

    switch (method) {
      case 'categories':
        result = await pdw.analytics.categories();
        break;

      case 'importance':
        result = await pdw.analytics.importance();
        break;

      case 'trends':
        result = await pdw.analytics.trends();
        break;

      case 'generate':
      default:
        result = await pdw.analytics.generate({
          includeInsights: true,
          includeClustering: false,
        });
        break;
    }

    console.log(`[TEST] analytics.${method}() result:`, JSON.stringify(result, null, 2).substring(0, 500));

    return NextResponse.json({
      success: true,
      method,
      walletAddress: walletAddress || DUMMY_WALLET,
      result,
    });
  } catch (error) {
    console.error(`[TEST] analytics.${method}() error:`, error);
    return NextResponse.json(
      {
        success: false,
        method,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
