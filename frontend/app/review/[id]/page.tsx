import { PlanReview } from "../../../components/PlanReview";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlanReview modelId={id} />;
}
