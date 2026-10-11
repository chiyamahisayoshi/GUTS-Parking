const { main } = require("./create-admin");

if (require.main === module) {
  main("operator").catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
