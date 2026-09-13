Master Application Document: Unified User-Centric Work Platform

1. Executive Summary & Application Overview

The Unified Work Platform is an all-in-one ecosystem designed to blur the traditional boundaries between clients, employees, independent contractors, and companies. At its core, the application is strictly User-Centric. Organizations are not the overarching rulers of the platform; rather, they are structural features that users can create, join, or interact with to collaborate and pool resources.

A single user account serves as a universal passport. From one central dashboard, a user can simultaneously operate as a client posting a home renovation project, an independent freelancer bidding on a solo gig, an employee logging hours for a massive construction company, and a manager tracking that company's overarching progress. By integrating project bidding, job networking, and dual-scale time/inventory management, the platform facilitates perfectly fluid professional interactions.

2. Overarching Goals

The Universal User Profile: Eliminate fragmented accounts. A single user profile handles hiring, seeking work, networking, and project management.

Comprehensive Job & Client Markets: Provide dual market boards: one for securing projects/clients (bidding on gigs and contracts) and one for securing traditional work (users applying for employee roles within organizations).

Scalable Time Management: Implement a bottom-up time tracking system. Users log time on their personal daily grids. If the work is for an organization, that data automatically syncs to the organization's macro-level dashboard for payroll and job-costing.

Fluid Project Execution: Allow independent users or organizations to win bids. If a project is large, it can be broken into subdivisions, allowing a mix of solo freelancers and large organizations to collaborate on different phases of the same project.

3. Phased Development Process & Milestones

Phase / Milestone

Core Deliverables

Target Timeline

Phase 1: The User Foundation

Universal User models, Profile creation, secure Auth, and the basic Organization creation feature.

Weeks 1 - 3

Phase 2: The Dual Markets

APIs for the Project Bidding Board (clients & contractors) and the Employment Board (companies & job seekers).

Weeks 4 - 7

Phase 3: Execution & Tracking

Personal time grids, organization roll-up dashboards, and personal/org inventory tracking.

Weeks 8 - 10

Phase 4: Fluid UI & Integration

EJS front-end deployment, ensuring seamless context switching between "Personal Mode" and "Org Mode".

Weeks 11 - 14

4. Software Requirements Specification (SRS)

4.1 User Capabilities (Context Switching)

Instead of static roles, a User switches contexts:

Personal Context: The user views their personal time grid, personal inventory (tools), solo bids on projects, and applications for employment.

Client Context: The user views projects they have posted to the market, reviews bids from freelancers or companies, and monitors active work being done for them.

Organization Context: If the user has managerial permissions, they view org-wide timesheets, shared corporate inventory, organizational project bids, and incoming employee applications.

4.2 Functional Requirements

Profile & Networking: Users can list skills, availability, and hourly rates on their profile.

Employment Board: Organizations (or individual users needing an assistant) can post jobs. Users can apply. Accepted users are added to the OrganizationMember roster.

Project Marketplace: Users post projects. The system must allow both solo Users and Organizations to submit bids.

Subdivision Collaboration: Large projects can be divided. A solo plumber (User) might win Subdivision A, while an electrical company (Organization) wins Subdivision B.

Unified Time Management: A Timesheet entry must always link to a User. It can optionally link to an Organization if the work was performed on behalf of one.

Inventory Flexibility: The system must track inventory owned by a User individually, as well as inventory owned by an Organization, mapping consumption accurately to active projects.

5. Foundation for System Design

5.1 Technology Stack

Backend: Node.js with Express.js

Database: PostgreSQL or MySQL managed via Sequelize ORM

Frontend: EJS (Embedded JavaScript), HTML5, CSS3, Vanilla JavaScript

5.2 Core Data Architecture (User-First ERD)

The Universal Core:

User (id, full_name, email, skills, availability_status)

Organization (id, name, created_by_user_id)

OrganizationMember (Join: user_id, org_id, internal_role)

Employment & Networking:

JobPosting (id, posted_by_user_id, posted_by_org_id [nullable], title, description)

JobApplication (id, job_posting_id, applicant_user_id, status)

Project & Market Engine:

Project (id, client_user_id, status)

ProjectSubdivision (id, project_id, awarded_user_id [nullable], awarded_org_id [nullable])

Bid (id, subdivision_id, bidding_user_id [nullable], bidding_org_id [nullable], amount)

Scalable Resource Tracking:

InventoryItem (id, owner_user_id [nullable], owner_org_id [nullable], item_name, stock)

ProjectInventory (Join: subdivision_id, item_id, qty)

Timesheet (id, user_id, subdivision_id, org_id [nullable], hours, date)

5.3 System Data Flow (The Fluid Day-in-the-Life)

Morning: User A logs in. They check their Employment Board and accept a job offer to join Acme Builders (Organization).

Mid-Day: User A switches to their Client Context. They post a personal project to the market: "Need my driveway paved."

Afternoon: User A goes to work for Acme Builders. They log 4 hours on their personal time grid for a specific project subdivision Acme is managing.

Result: The system automatically updates User A's personal total hours for the week, while simultaneously rolling those 4 hours up into Acme Builders' macro-dashboard for project labor costing.