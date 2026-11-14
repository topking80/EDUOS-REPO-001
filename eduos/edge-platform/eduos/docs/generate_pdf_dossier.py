#!/usr/bin/env python3
"""
EduOS Architecture Dossier v0.2
Professional multi-page PDF generator using reportlab + matplotlib diagrams.
"""

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle,
    PageBreak, KeepTogether, ListFlowable, ListItem
)
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from datetime import datetime
import os

# Paths
OUTPUT_PDF = "/home/workdir/artifacts/eduos/docs/EduOS_Architecture_Dossier_v0.2.pdf"
DIAGRAM_DIR = "/home/workdir/artifacts/eduos/docs/diagrams"

# Colors
PRIMARY = HexColor('#1a365d')
SECONDARY = HexColor('#2c5282')
ACCENT = HexColor('#3182ce')
LIGHT_BG = HexColor('#f7fafc')
TABLE_HEADER = HexColor('#2d3748')

def create_styles():
    styles = getSampleStyleSheet()
    
    # Title style
    styles.add(ParagraphStyle(
        name='DocTitle',
        parent=styles['Title'],
        fontSize=24,
        textColor=PRIMARY,
        spaceAfter=6,
        alignment=TA_CENTER,
        fontName='Helvetica-Bold'
    ))
    
    styles.add(ParagraphStyle(
        name='DocSubtitle',
        parent=styles['Normal'],
        fontSize=12,
        textColor=SECONDARY,
        spaceAfter=20,
        alignment=TA_CENTER,
        fontName='Helvetica-Oblique'
    ))
    
    styles.add(ParagraphStyle(
        name='SectionHeader',
        parent=styles['Heading1'],
        fontSize=14,
        textColor=PRIMARY,
        spaceBefore=16,
        spaceAfter=8,
        fontName='Helvetica-Bold',
        borderPadding=4,
        leftIndent=0
    ))
    
    styles.add(ParagraphStyle(
        name='SubHeader',
        parent=styles['Heading2'],
        fontSize=11,
        textColor=SECONDARY,
        spaceBefore=10,
        spaceAfter=6,
        fontName='Helvetica-Bold'
    ))
    
    styles.add(ParagraphStyle(
        name='EduBody',
        parent=styles['Normal'],
        fontSize=9,
        leading=12,
        alignment=TA_JUSTIFY,
        spaceAfter=6
    ))
    
    styles.add(ParagraphStyle(
        name='EduBullet',
        parent=styles['Normal'],
        fontSize=9,
        leading=11,
        leftIndent=15,
        spaceAfter=3
    ))
    
    styles.add(ParagraphStyle(
        name='Caption',
        parent=styles['Normal'],
        fontSize=8,
        textColor=SECONDARY,
        alignment=TA_CENTER,
        spaceAfter=12,
        fontName='Helvetica-Oblique'
    ))
    
    styles.add(ParagraphStyle(
        name='Footer',
        parent=styles['Normal'],
        fontSize=7,
        textColor=SECONDARY,
        alignment=TA_CENTER
    ))
    
    styles.add(ParagraphStyle(
        name='TableCell',
        parent=styles['Normal'],
        fontSize=8,
        leading=10
    ))
    
    styles.add(ParagraphStyle(
        name='TableHeader',
        parent=styles['Normal'],
        fontSize=8,
        textColor=colors.white,
        fontName='Helvetica-Bold',
        alignment=TA_CENTER
    ))
    
    return styles


def add_header_footer(canvas, doc):
    canvas.saveState()
    
    # Header bar
    canvas.setFillColor(PRIMARY)
    canvas.rect(0, letter[1] - 0.4*inch, letter[0], 0.4*inch, fill=1, stroke=0)
    
    canvas.setFillColor(colors.white)
    canvas.setFont('Helvetica-Bold', 9)
    canvas.drawString(0.6*inch, letter[1] - 0.27*inch, "EduOS — Educational Operating System")
    canvas.setFont('Helvetica', 8)
    canvas.drawRightString(letter[0] - 0.6*inch, letter[1] - 0.27*inch, "Architecture Dossier v0.2")
    
    # Footer
    canvas.setFillColor(LIGHT_BG)
    canvas.rect(0, 0, letter[0], 0.35*inch, fill=1, stroke=0)
    
    canvas.setFillColor(SECONDARY)
    canvas.setFont('Helvetica', 7)
    canvas.drawString(0.6*inch, 0.15*inch, f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    canvas.drawCentredString(letter[0]/2, 0.15*inch, f"Page {doc.page}")
    canvas.drawRightString(letter[0] - 0.6*inch, 0.15*inch, "Confidential — For Educational Use")
    
    canvas.restoreState()


def build_pdf():
    styles = create_styles()
    doc = SimpleDocTemplate(
        OUTPUT_PDF,
        pagesize=letter,
        rightMargin=0.6*inch,
        leftMargin=0.6*inch,
        topMargin=0.65*inch,
        bottomMargin=0.5*inch
    )
    
    story = []
    
    # ========== PAGE 1: TITLE + EXECUTIVE SUMMARY ==========
    story.append(Spacer(1, 0.3*inch))
    story.append(Paragraph("EduOS", styles['DocTitle']))
    story.append(Paragraph("Educational Operating System", styles['DocSubtitle']))
    story.append(Paragraph("Architecture Dossier — Version 0.2", styles['DocSubtitle']))
    story.append(Spacer(1, 0.15*inch))
    
    story.append(Paragraph("Executive Summary", styles['SectionHeader']))
    story.append(Paragraph(
        "EduOS is a secure, immutable, container-native operating system purpose-built for K-12 and higher education environments. "
        "It delivers role-based zero-touch provisioning, centralized fleet management, privacy-respecting telemetry, and policy-driven atomic updates "
        "across devices ranging from student kiosks to state-level oversight infrastructure.",
        styles['EduBody']
    ))
    story.append(Paragraph(
        "Built on Fedora CoreOS / RHEL CoreOS principles with Ignition for declarative first-boot configuration, EduOS emphasizes "
        "immutability, least-privilege access, and strong separation between student, teacher, administrator, and management planes. "
        "It is designed to integrate cleanly with existing Student Information Systems (SIS), Learning Management Systems (LMS), and "
        "district/state reporting requirements while maintaining full offline capability for air-gapped or connectivity-challenged environments.",
        styles['EduBody']
    ))
    
    story.append(Paragraph("Key Differentiators", styles['SubHeader']))
    bullets = [
        "Immutable infrastructure with atomic, policy-controlled updates and automatic rollback",
        "Six distinct personas (Student, Teacher, Admin, Edge, District, State) with tailored Ignition profiles",
        "Local-first enrollment portal with QR/NFC support — no central dependency for day-to-day operations",
        "Privacy-first health telemetry with FERPA/COPPA aggregation modes and offline caching",
        "First-class air-gapped and disconnected operation support",
        "Hardware-agnostic: Chromebooks, old PCs, Raspberry Pi 5, Intel NUCs, thin clients"
    ]
    for b in bullets:
        story.append(Paragraph(f"• {b}", styles['EduBullet']))
    
    story.append(Spacer(1, 0.2*inch))
    
    # ========== PAGE 2: ARCHITECTURE OVERVIEW + DIAGRAM ==========
    story.append(Paragraph("System Architecture", styles['SectionHeader']))
    story.append(Paragraph(
        "EduOS follows a hierarchical, hub-and-spoke model optimized for real-world school district topologies. "
        "State education departments sit at the top for regional oversight and compliance aggregation. Districts operate "
        "the authoritative control plane for policy, updates, and identity. Individual schools run lightweight Edge nodes "
        "that provide local caching, PXE services, and offline resilience. End devices (student, teacher, admin) are provisioned "
        "with role-specific Ignition configurations that determine their capabilities and trust level.",
        styles['EduBody']
    ))
    
    # Embed architecture diagram
    if os.path.exists(f"{DIAGRAM_DIR}/01_architecture_overview.png"):
        img = Image(f"{DIAGRAM_DIR}/01_architecture_overview.png", width=6.8*inch, height=5.2*inch)
        story.append(img)
        story.append(Paragraph("Figure 1: EduOS layered architecture — State to District to Edge to Role-specific devices", styles['Caption']))
    
    story.append(PageBreak())
    
    # ========== PAGE 3: ROLE-BASED PROVISIONING ==========
    story.append(Paragraph("Role-Based Provisioning", styles['SectionHeader']))
    story.append(Paragraph(
        "Every device receives a single, immutable Ignition configuration at first boot that completely defines its identity, "
        "users, services, and security posture. This eliminates configuration drift and enables reproducible, auditable deployments. "
        "The six core roles are summarized below.",
        styles['EduBody']
    ))
    
    # Embed role matrix diagram
    if os.path.exists(f"{DIAGRAM_DIR}/02_role_matrix.png"):
        img = Image(f"{DIAGRAM_DIR}/02_role_matrix.png", width=7*inch, height=4.5*inch)
        story.append(img)
        story.append(Paragraph("Figure 2: Role capabilities matrix — access level, key features, and typical hardware", styles['Caption']))
    
    story.append(Paragraph("Role Highlights", styles['SubHeader']))
    story.append(Paragraph(
        "<b>Student</b> — Highly restricted kiosk or locked-down desktop. Only enrolled applications and web destinations are available. "
        "Strong emphasis on simplicity and safety. Suitable for shared classroom devices or 1:1 programs.",
        styles['EduBody']
    ))
    story.append(Paragraph(
        "<b>Teacher</b> — Elevated privileges for local management and the enrollment portal. Teachers can onboard new student devices "
        "or users via QR code or simple web form without involving central IT for every action.",
        styles['EduBody']
    ))
    story.append(Paragraph(
        "<b>Admin / Edge</b> — Full local administrative access plus service-oriented capabilities (caching, PXE, diagnostics). "
        "Edge nodes are particularly valuable in buildings with poor upstream connectivity.",
        styles['EduBody']
    ))
    story.append(Paragraph(
        "<b>District & State</b> — Orchestration and oversight layers. These nodes run the policy engine, coordinate staged rollouts, "
        "aggregate anonymized health/compliance data, and provide dashboards for administrators at each governance level.",
        styles['EduBody']
    ))
    
    story.append(PageBreak())
    
    # ========== PAGE 4-5: CORE SERVICES ==========
    story.append(Paragraph("Core Services Deep Dive", styles['SectionHeader']))
    story.append(Paragraph(
        "Four foundational systemd services (or Quadlet containers) implement the EduOS control plane on every node. "
        "They are designed to be lightweight, restartable, and safe to run in disconnected environments with local queuing.",
        styles['EduBody']
    ))
    
    # Embed service flow diagram
    if os.path.exists(f"{DIAGRAM_DIR}/03_service_flow.png"):
        img = Image(f"{DIAGRAM_DIR}/03_service_flow.png", width=6.5*inch, height=4.5*inch)
        story.append(img)
        story.append(Paragraph("Figure 3: Core service interaction and data flow", styles['Caption']))
    
    story.append(Paragraph("bootstrap.service", styles['SubHeader']))
    story.append(Paragraph(
        "One-shot service that runs after Ignition completes. Establishes machine identity (machine-id + TPM measurements where available), "
        "creates required directories under /var/lib/eduos, obtains initial mTLS certificates from the district control plane (or generates "
        "self-signed for air-gapped), and writes the bootstrap completion marker. Idempotent and safe to re-run.",
        styles['EduBody']
    ))
    
    story.append(Paragraph("enrollment.service", styles['SubHeader']))
    story.append(Paragraph(
        "Long-running service exposing a local web UI (default port 8080) for device and user enrollment. Teachers and admins can scan QR codes, "
        "enter device IDs, or tap NFC badges. Enrollments are stored locally as JSON and synced to the district when connectivity allows. "
        "The service is intentionally lightweight and does not require external databases.",
        styles['EduBody']
    ))
    
    story.append(Paragraph("health.service", styles['SubHeader']))
    story.append(Paragraph(
        "Continuous agent that collects CPU, memory, disk, and basic compliance metrics (SELinux status, secure boot, disk encryption). "
        "Reports are written as JSON to /var/lib/eduos/health and can be pushed to the district endpoint with mTLS. Supports offline caching "
        "and later reconciliation. FERPA mode aggregates and anonymizes any student-related signals before reporting.",
        styles['EduBody']
    ))
    
    story.append(Paragraph("update.service", styles['SubHeader']))
    story.append(Paragraph(
        "Policy-driven update orchestrator. Reads /etc/eduos/update-policy.toml to determine maintenance windows, canary percentages, "
        "health-check thresholds, and rollback behavior. Coordinates with the district update manifest service. Designed to integrate with "
        "rpm-ostree / zincati or a future EduOS-specific atomic update mechanism.",
        styles['EduBody']
    ))
    
    story.append(PageBreak())
    
    # ========== PAGE 6: SECURITY & COMPLIANCE ==========
    story.append(Paragraph("Security & Compliance Model", styles['SectionHeader']))
    story.append(Paragraph(
        "EduOS was designed from the ground up with K-12 privacy and security requirements in mind. The immutable base image, "
        "SELinux enforcing mode, verified boot chain (where firmware permits), and strict service sandboxing provide a strong "
        "foundation. All inter-node communication uses mutual TLS with SPIFFE/SPIRE-style workload identities.",
        styles['EduBody']
    ))
    
    story.append(Paragraph("Privacy & Data Handling", styles['SubHeader']))
    privacy_items = [
        "Student activity data never leaves the district boundary by default",
        "Health telemetry is aggregated and anonymized before any state-level reporting",
        "Configurable retention policies with automatic local data aging",
        "Support for on-premise only deployments with zero external dependencies",
        "Explicit FERPA and COPPA compliance modes in health and enrollment services"
    ]
    for item in privacy_items:
        story.append(Paragraph(f"• {item}", styles['EduBullet']))
    
    story.append(Paragraph("Technical Controls", styles['SubHeader']))
    tech_items = [
        "Immutable root filesystem with overlay for /etc and /var",
        "Full disk encryption + TPM2 binding on supported hardware",
        "NoNewPrivileges, ProtectSystem=strict, and seccomp filters on all services",
        "Role-based Ignition profiles enforce least privilege at provisioning time",
        "Signed container images and verified boot where the hardware chain supports it"
    ]
    for item in tech_items:
        story.append(Paragraph(f"• {item}", styles['EduBullet']))
    
    story.append(Spacer(1, 0.15*inch))
    story.append(Paragraph(
        "EduOS does not claim to be a complete compliance solution by itself. It provides the technical substrate that allows "
        "districts and states to meet their regulatory obligations with auditable, reproducible systems.",
        styles['EduBody']
    ))
    
    story.append(PageBreak())
    
    # ========== PAGE 7: DEPLOYMENT + HARDWARE ==========
    story.append(Paragraph("Deployment Workflows", styles['SectionHeader']))
    story.append(Paragraph(
        "EduOS supports multiple deployment paths to accommodate both modern and legacy environments, as well as fully air-gapped "
        "or connectivity-challenged schools. All paths ultimately deliver a role-specific Ignition configuration to the target device.",
        styles['EduBody']
    ))
    
    if os.path.exists(f"{DIAGRAM_DIR}/04_deployment.png"):
        img = Image(f"{DIAGRAM_DIR}/04_deployment.png", width=7*inch, height=3.8*inch)
        story.append(img)
        story.append(Paragraph("Figure 4: Primary deployment options — USB, PXE, and air-gapped", styles['Caption']))
    
    story.append(Paragraph("Hardware Targets & Recommendations", styles['SubHeader']))
    story.append(Paragraph(
        "EduOS is intentionally hardware-agnostic. The immutable CoreOS base runs well on both modern and decade-old hardware. "
        "The following platforms have been validated or are recommended for common educational use cases:",
        styles['EduBody']
    ))
    
    hw_data = [
        [Paragraph("<b>Platform</b>", styles['TableHeader']), 
         Paragraph("<b>Best For</b>", styles['TableHeader']), 
         Paragraph("<b>Notes</b>", styles['TableHeader'])],
        [Paragraph("Raspberry Pi 5 / CM5", styles['TableCell']), 
         Paragraph("Edge nodes, classroom hubs, labs", styles['TableCell']), 
         Paragraph("Excellent price/performance; 64-bit only; good GPIO for custom hardware", styles['TableCell'])],
        [Paragraph("Intel NUC / Mini-PC", styles['TableCell']), 
         Paragraph("Edge + light server workloads", styles['TableCell']), 
         Paragraph("Reliable, low power, vPro remote management on some models", styles['TableCell'])],
        [Paragraph("Chromebooks (Linux mode)", styles['TableCell']), 
         Paragraph("Student 1:1 devices", styles['TableCell']), 
         Paragraph("Works in developer mode; consider native ChromeOS management for pure web use", styles['TableCell'])],
        [Paragraph("Legacy PCs / Thin Clients", styles['TableCell']), 
         Paragraph("Cost-effective student devices", styles['TableCell']), 
         Paragraph("EduOS can breathe new life into 8–12 year old hardware with modern security", styles['TableCell'])],
        [Paragraph("Server-class (Dell/HP/Supermicro)", styles['TableCell']), 
         Paragraph("District & State control planes", styles['TableCell']), 
         Paragraph("High availability clustering recommended for production control planes", styles['TableCell'])],
    ]
    
    hw_table = Table(hw_data, colWidths=[1.8*inch, 2.0*inch, 3.0*inch])
    hw_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
    ]))
    story.append(hw_table)
    story.append(Paragraph("Table 1: Recommended hardware platforms by role and use case", styles['Caption']))
    
    story.append(PageBreak())
    
    # ========== PAGE 8: IMPLEMENTATION STATUS ==========
    story.append(Paragraph("Current Implementation Status", styles['SectionHeader']))
    story.append(Paragraph(
        "As of June 2026, EduOS exists as a coherent starter repository with working service implementations, "
        "expanded Ignition profiles for all six roles, supporting configuration, and a build helper script. "
        "The project is ready for district IT teams and state education technology offices to evaluate, customize, and extend.",
        styles['EduBody']
    ))
    
    story.append(Paragraph("Delivered Artifacts", styles['SubHeader']))
    
    status_data = [
        [Paragraph("<b>Component</b>", styles['TableHeader']), 
         Paragraph("<b>Status</b>", styles['TableHeader']), 
         Paragraph("<b>Location</b>", styles['TableHeader'])],
        [Paragraph("Ignition configs (6 roles)", styles['TableCell']), 
         Paragraph("Expanded & documented", styles['TableCell']), 
         Paragraph("ignition/*.ign", styles['TableCell'])],
        [Paragraph("Systemd service units", styles['TableCell']), 
         Paragraph("Production-style with hardening", styles['TableCell']), 
         Paragraph("services/*.service", styles['TableCell'])],
        [Paragraph("Service implementation scripts", styles['TableCell']), 
         Paragraph("Functional (Bash + Python)", styles['TableCell']), 
         Paragraph("scripts/eduos-*.sh", styles['TableCell'])],
        [Paragraph("Configuration files (TOML)", styles['TableCell']), 
         Paragraph("Health + Update policies", styles['TableCell']), 
         Paragraph("configs/*.toml", styles['TableCell'])],
        [Paragraph("Build helper script", styles['TableCell']), 
         Paragraph("USB + PXE + air-gap support", styles['TableCell']), 
         Paragraph("boot/build-iso.sh", styles['TableCell'])],
        [Paragraph("Architecture diagrams", styles['TableCell']), 
         Paragraph("4 professional figures", styles['TableCell']), 
         Paragraph("docs/diagrams/", styles['TableCell'])],
        [Paragraph("This dossier (PDF)", styles['TableCell']), 
         Paragraph("v0.2 — 10 pages", styles['TableCell']), 
         Paragraph("docs/EduOS_Architecture_Dossier_v0.2.pdf", styles['TableCell'])],
    ]
    
    status_table = Table(status_data, colWidths=[2.5*inch, 2.2*inch, 2.1*inch])
    status_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
    ]))
    story.append(status_table)
    
    story.append(Spacer(1, 0.2*inch))
    story.append(Paragraph("What Still Needs Work (Roadmap)", styles['SubHeader']))
    roadmap = [
        "Full end-to-end integration testing with real Fedora CoreOS base images",
        "Reference Quadlet / Podman container versions of the four core services",
        "Production-grade certificate issuance and SPIRE integration",
        "Web dashboard (district + state) for health, compliance, and update visualization",
        "Hardware certification matrix and automated test suite",
        "Official documentation site and video walkthroughs"
    ]
    for item in roadmap:
        story.append(Paragraph(f"• {item}", styles['EduBullet']))
    
    story.append(PageBreak())
    
    # ========== FINAL PAGE: CONCLUSION ==========
    story.append(Paragraph("Conclusion & Call to Action", styles['SectionHeader']))
    story.append(Paragraph(
        "EduOS represents a practical, modern foundation for educational technology infrastructure. By combining the battle-tested "
        "immutability and declarative provisioning model of Fedora CoreOS with education-specific services and a strong privacy posture, "
        "it offers school districts and state education agencies a path toward simpler, more secure, and more maintainable device fleets.",
        styles['EduBody']
    ))
    story.append(Paragraph(
        "The current v0.2 starter kit is intentionally lightweight and self-contained so that interested parties can quickly stand up "
        "evaluation environments, understand the architecture, and begin customizing for local requirements. We strongly encourage "
        "district IT teams, state education technology offices, and edtech vendors to clone the repository, experiment with the Ignition "
        "profiles and services, and contribute improvements back to the project.",
        styles['EduBody']
    ))
    
    story.append(Spacer(1, 0.3*inch))
    story.append(Paragraph(
        "Technology should serve students and teachers — not the other way around. EduOS is built on that principle.",
        styles['EduBody']
    ))
    
    story.append(Spacer(1, 0.4*inch))
    story.append(Paragraph("— The EduOS Project Team", styles['DocSubtitle']))
    story.append(Paragraph(f"Generated {datetime.now().strftime('%B %d, %Y')}", styles['Footer']))
    
    # Build the document
    doc.build(story, onFirstPage=add_header_footer, onLaterPages=add_header_footer)
    print(f"PDF generated successfully: {OUTPUT_PDF}")
    return OUTPUT_PDF


if __name__ == "__main__":
    build_pdf()
