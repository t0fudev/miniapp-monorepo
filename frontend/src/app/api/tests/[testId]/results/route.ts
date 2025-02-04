import { getXataClient } from "@/lib/utils";
import { NextResponse } from "next/server";
import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

const secret = new TextEncoder().encode(JWT_SECRET);

interface CategoryScore {
  category_xata_id: string;
  score: number;
}

/**
 * @swagger
 * /api/tests/{testId}/results:
 *   get:
 *     summary: Get test results and insights
 *     description: Retrieves test scores and generates insights based on user's answers
 *     parameters:
 *       - name: testId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Successfully retrieved test results and insights
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   category:
 *                     type: string
 *                     example: "Economic"
 *                   insight:
 *                     type: string
 *                     example: "You relate more to..."
 *                   description:
 *                     type: string
 *                     example: "Centrist"
 *                   percentage:
 *                     type: number
 *                     example: 40
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Test progress not found
 *       500:
 *         description: Internal server error
 */
export async function GET(
  request: Request,
  { params }: { params: { testId: string } }
) {
  try {
    const xata = getXataClient();
    let user;

    // Try JWT session from wallet auth
    const token = cookies().get('session')?.value;
    
    if (!token) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    try {
      const { payload } = await jwtVerify(token, secret);
      if (payload.address) {
        user = await xata.db.Users.filter({ 
          wallet_address: payload.address 
        }).getFirst();
      }
    } catch (error) {
      console.error('JWT verification failed:', error);
      return NextResponse.json(
        { error: "Invalid session" },
        { status: 401 }
      );
    }

    if (!user) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    // Get test progress
    const progress = await xata.db.UserTestProgress.filter({
      "user.xata_id": user.xata_id,
      "test.test_id": parseInt(params.testId)
    }).getFirst();

    if (!progress) {
      return NextResponse.json(
        { error: "Test progress not found" },
        { status: 404 }
      );
    }

    if (!progress.score) {
      return NextResponse.json(
        { error: "Test not completed" },
        { status: 400 }
      );
    }

    // Get all categories with their names
    const categories = await xata.db.Categories.getAll();
    
    // Map scores to categories
    const categoryScores: CategoryScore[] = [
      { category_xata_id: categories.find(c => c.category_name === "Economic")?.xata_id || "", score: progress.score.econ },
      { category_xata_id: categories.find(c => c.category_name === "Civil")?.xata_id || "", score: progress.score.govt },
      { category_xata_id: categories.find(c => c.category_name === "Diplomatic")?.xata_id || "", score: progress.score.dipl },
      { category_xata_id: categories.find(c => c.category_name === "Societal")?.xata_id || "", score: progress.score.scty }
    ].filter(cs => cs.category_xata_id !== "");

    // Process each category score
    const results = [];
    const test = await xata.db.Tests.filter({ test_id: parseInt(params.testId) }).getFirst();

    if (!test) {
      return NextResponse.json(
        { error: "Test not found" },
        { status: 404 }
      );
    }

    // Round all scores to integers
    categoryScores.forEach(cs => cs.score = Math.round(cs.score));

    for (const categoryScore of categoryScores) {
      // Find matching insight based on score
      const insight = await xata.db.Insights.filter({
        "category.xata_id": categoryScore.category_xata_id,
        lower_limit: { $le: categoryScore.score },
        upper_limit: { $gt: categoryScore.score }
      }).getFirst();

      if (insight) {
        // Get category details
        const category = categories.find(c => c.xata_id === categoryScore.category_xata_id);
        
        if (category) {
          // Save to InsightsPerUserCategory
          const latestInsight = await xata.db.InsightsPerUserCategory
            .sort("insight_user_id", "desc")
            .getFirst();
          const nextInsightId = (latestInsight?.insight_user_id || 0) + 1;

          // Get range description based on score
          let range = 'neutral'
          if (categoryScore.score >= 45 && categoryScore.score <= 55) {
            range = 'centrist'
          } else if (categoryScore.score >= 35 && categoryScore.score < 45) {
            range = 'moderate'
          } else if (categoryScore.score >= 25 && categoryScore.score < 35) {
            range = 'balanced'
          }

          await xata.db.InsightsPerUserCategory.create({
            category: category.xata_id,
            insight: insight.xata_id,
            test: test.xata_id,
            user: user.xata_id,
            description: range,
            percentage: categoryScore.score,
            insight_user_id: nextInsightId
          });

          // Add to results
          results.push({
            category: category.category_name,
            insight: insight.insight,
            description: range,
            percentage: categoryScore.score
          });
        }
      }
    }

    // Update progress status to completed
    await progress.update({
      status: "completed",
      completed_at: new Date()
    });

    return NextResponse.json(results);

  } catch (error) {
    console.error("Error processing test results:", error);
    return NextResponse.json(
      { error: "Failed to process test results" },
      { status: 500 }
    );
  }
}
