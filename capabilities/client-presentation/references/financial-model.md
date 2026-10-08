# Ownership Illustration

`assets/site/finance.js` implements scenario arithmetic, not lending policy or investment advice. A client configuration must provide every assumption explicitly; the factory includes no business defaults. The synthetic fixtures are labelled test data and are not a source for client assumptions.

## Contract

`PresentationFinance.compute(property, assumptions, tiRate)` returns numeric totals and annual points. A property requires a nonnegative `price` and positive integer `totalSf`. Assumptions require `occupancyFraction`, `downPaymentFraction`, `annualInterest`, `amortizationYears`, `holdYears`, `annualAppreciation`, `annualRentPerSf`, `collectionLoss`, `fillMonths`, and `practiceBuildoutPerSf`. Fractions are decimals and rates are annual. The practice area rounds up once; tenant area is the remainder.

The `owner_occupancy` strategy fixes practice occupancy at 100%, so tenant area, rent offsets, and tenant TI are zero. The `owner_occupancy_30_70` strategy fixes practice occupancy at 30% and tenant area at 70%; it is a distinct outside-tenant scenario, never an owner-occupancy claim. `lease_only` omits ownership calculations. Assumptions must be reviewed for the specific client and property before showing a result.

## Formulas

- Practice SF = ceil(total SF × occupancy); tenant SF = total SF − practice SF.
- Loan = purchase price × (1 − down-payment fraction); down payment = purchase price × down-payment fraction.
- Monthly principal and interest follow the stated amortization schedule, with no interest-only period or balloon. At zero interest, payment = loan / number of months.
- Value at year y = purchase price × (1 + annual appreciation)^y. Equity = value − remaining loan balance. Equity includes the initial down payment and is not liquid cash.
- Stabilized outside monthly rent = tenant SF × annual rent/SF ÷ 12 × (1 − collection loss). The configured fill period ramps collection to that amount; zero months means full collection from month one.
- Mortgage payments funded = cumulative loan payments − collected tenant rent. A negative result is a modeled surplus, not operating profit.
- Practice rent avoided = practice SF × annual rent/SF × hold years. It assumes the same rent basis for the leasing alternative.
- Practice buildout = practice SF × buildout cost/SF. Tenant TI = tenant SF × selected TI/SF. The combined improvement budget is separate from purchase price and down payment.
- Extra cash versus leasing = down payment + mortgage payments funded + tenant TI − practice rent avoided.
- Estimated financial benefit = year-end equity − extra cash versus leasing.

The illustration is undiscounted. It excludes closing and selling costs, taxes, commissions, reserves, repairs, capital expenditures, unreimbursed owner expenses and opportunity cost unless the configuration explicitly models them. A plotted crossing is not investment break-even. Gross or imputed rent is not verified NOI or a cap rate. Show the assumptions and limitations with every client-facing result.

Round displayed amounts only; retain precision during calculations. Tests independently reconcile amortization and rent collection, verify full occupancy produces zero tenant area and rent, and verify 30/70 TI changes affect only tenant area.
