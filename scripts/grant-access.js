const { BigQuery } = require('@google-cloud/bigquery');

const projectId = 'test-2163-kobuchi-shu';
const datasetId = 'friction_ops';
const email = 'service-725918177870@gcp-sa-pubsub.iam.gserviceaccount.com';

const bigquery = new BigQuery({ projectId });

async function main() {
  console.log(`Fetching metadata for dataset: ${datasetId}`);
  const dataset = bigquery.dataset(datasetId);
  const [metadata] = await dataset.getMetadata();
  const access = metadata.access;

  // Check if already exists
  const exists = access.some(a => a.userByEmail && a.userByEmail.toLowerCase() === email.toLowerCase());
  if (!exists) {
    access.push({
      role: 'WRITER',
      userByEmail: email
    });
    await dataset.setMetadata({ access });
    console.log(`Successfully granted WRITER role to ${email} on dataset ${datasetId}`);
  } else {
    console.log(`${email} already has access to dataset ${datasetId}`);
  }
}

main().catch(err => {
  console.error('Error granting dataset access:', err);
  process.exit(1);
});
