#!/usr/bin/env python3
"""
EduOS 2-Page Executive Summary PDF
"""

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.pdfgen import canvas
from datetime import datetime

OUTPUT = "/home/workdir/artifacts/eduos/docs/EduOS_Executive_Summary_v0.2.pdf"
PRIMARY = colors.HexColor('#1a365d')
SECONDARY = colors.HexColor('#2c5282')
LIGHT_BG = colors.HexColor('#f7fafc')

def add_header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(PRIMARY)
    canvas.rect(0, letter[1] - 0.35*inch, letter[0], 0.35*inch, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont('Helvetica-Bold', 8)
    canvas.drawString(0.5*inch, letter[1] - 0.24*inch, "EduOS Executive Summary v0.2")
    canvas.setFont('Helvetica', 7)
    canvas.drawRightString(letter[0] - 0.5*inch, letter[1] - 0.24*inch, datetime.now().strftime("%Y-%m-%d"))
    canvas.restoreState()

def build():
    styles = getSampleStyleSheet()
    
    styles.add(ParagraphStyle(name='MainTitle', fontSize=18, textColor=PRIMARY, alignment=TA_CENTER, fontName='Helvetica-Bold', spaceAfter=4))
    styles.add(ParagraphStyle(name='Sub', fontSize=10, textColor=SECONDARY, alignment=TA_CENTER, fontName='Helvetica-Oblique', spaceAfter=12))
    styles.add(ParagraphStyle(name='H1', fontSize=11, textColor=PRIMARY, fontName='Helvetica-Bold', spaceBefore=10, spaceAfter=4))
    styles.add(ParagraphStyle(name='Body', fontSize=8.5, leading=11, alignment=TA_JUSTIFY, spaceAfter=5))
    styles.add(ParagraphStyle(name='EduExecBullet', fontSize=8, leading=10, leftIndent=12, spaceAfter=2))
    
    doc = SimpleDocTemplate(OUTPUT, pagesize=letter, rightMargin=0.5*inch, leftMargin=0.5*inch, topMargin=0.5*inch, bottomMargin=0.4*inch)
    story = []
    
    # Page 1
    story.append(Paragraph("EduOS — Educational Operating System", styles['MainTitle']))
    story.append(Paragraph("Executive Summary | Version 0.2 | June 2026", styles['Sub']))
    
    story.append(Paragraph("What is EduOS?", styles['H1']))
    story.append(Paragraph(
        "EduOS is a secure, immutable, container-native Linux distribution purpose-built for K-12 and higher education. "
        "It combines the proven immutability and declarative provisioning model of Fedora CoreOS with education-specific services for enrollment, "
        "health telemetry, policy-driven updates, and strong privacy controls aligned with FERPA and COPPA.",
        styles['Body']
    ))
    
    story.append(Paragraph("Why EduOS Matters", styles['H1']))
    bullets = [
        "Reduces device management burden on already-overloaded school IT teams",
        "Enables consistent, auditable, and reproducible device states across thousands of endpoints",
        "Provides first-class support for air-gapped and low-connectivity environments common in education",
        "Gives districts and states the technical foundation to meet compliance requirements without sacrificing usability"
    ]
    for b in bullets:
        story.append(Paragraph(f"• {b}", styles['EduExecBullet']))
    
    story.append(Paragraph("Architecture at a Glance", styles['H1']))
    story.append(Paragraph(
        "Hierarchical model: <b>State</b> (oversight & aggregation) → <b>District</b> (policy & control plane) → <b>Edge</b> (school/building hubs with local cache & PXE) → <b>Devices</b> (Student, Teacher, Admin personas with role-specific Ignition configs). "
        "All services run as systemd units or modern Quadlet Podman containers.",
        styles['Body']
    ))
    
    story.append(Paragraph("Six Role Personas", styles['H1']))
    
    role_data = [
        [Paragraph("<b>Role</b>", styles['Body']), Paragraph("<b>Access</b>", styles['Body']), Paragraph("<b>Primary Use</b>", styles['Body'])],
        [Paragraph("Student", styles['Body']), Paragraph("Restricted / Kiosk", styles['Body']), Paragraph("Locked-down learning devices", styles['Body'])],
        [Paragraph("Teacher", styles['Body']), Paragraph("Elevated", styles['Body']), Paragraph("Local management + enrollment portal", styles['Body'])],
        [Paragraph("Admin", styles['Body']), Paragraph("High", styles['Body']), Paragraph("School IT & diagnostics", styles['Body'])],
        [Paragraph("Edge", styles['Body']), Paragraph("Service", styles['Body']), Paragraph("Classroom hub, cache, PXE, offline sync", styles['Body'])],
        [Paragraph("District", styles['Body']), Paragraph("Orchestration", styles['Body']), Paragraph("Fleet policy, updates, aggregation", styles['Body'])],
        [Paragraph("State", styles['Body']), Paragraph("Oversight", styles['Body']), Paragraph("Regional dashboards & compliance", styles['Body'])],
    ]
    
    t = Table(role_data, colWidths=[1.1*inch, 1.3*inch, 4.3*inch])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), PRIMARY),
        ('TEXTCOLOR', (0,0), (-1,0), colors.white),
        ('FONTSIZE', (0,0), (-1,-1), 7.5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 3),
        ('TOPPADDING', (0,0), (-1,-1), 3),
        ('GRID', (0,0), (-1,-1), 0.5, colors.grey),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, LIGHT_BG]),
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ]))
    story.append(t)
    story.append(Spacer(1, 0.1*inch))
    
    story.append(Paragraph("Current Status (June 2026)", styles['H1']))
    story.append(Paragraph(
        "v0.2 starter kit is complete and ready for evaluation. Includes: expanded Ignition configs for all 6 roles, working implementation of the four core services (Bootstrap, Enrollment, Health, Update), Quadlet container definitions, Raspberry Pi 5 guidance, full air-gapped deployment support, professional architecture diagrams, and this executive summary + 8-page technical dossier.",
        styles['Body']
    ))
    
    story.append(PageBreak())
    
    # Page 2
    story.append(Paragraph("Key Technical Capabilities", styles['H1']))
    
    caps = [
        "<b>Immutable & Atomic</b> — CoreOS-style immutability with policy-controlled updates and automatic rollback on health degradation.",
        "<b>Zero-Touch Provisioning</b> — Ignition-based first-boot configuration. Single ISO can serve any role via embedded or remote configs.",
        "<b>Local-First Enrollment</b> — Teachers can onboard devices and users via local web UI (QR/NFC friendly) even when disconnected from central systems.",
        "<b>Privacy by Design</b> — Health telemetry supports FERPA aggregation mode. Student data stays inside district boundary by default. Full offline caching + later sync.",
        "<b>Air-Gap Native</b> — Pre-embedded Ignition, local service operation, and USB-based update delivery are first-class supported paths.",
        "<b>Hardware Flexible</b> — Runs on Raspberry Pi 5 / CM5, Intel NUCs, legacy PCs, thin clients, and server-class hardware.  x86_64 and aarch64 supported."
    ]
    for c in caps:
        story.append(Paragraph(f"• {c}", styles['EduExecBullet']))
    
    story.append(Paragraph("Security & Compliance Posture", styles['H1']))
    story.append(Paragraph(
        "SELinux enforcing, full disk encryption + TPM2 binding (where available), strict systemd sandboxing on all services, mTLS between nodes, and signed artifacts. "
        "EduOS provides the technical controls that allow districts and states to meet regulatory requirements; it is not a complete compliance product by itself.",
        styles['Body']
    ))
    
    story.append(Paragraph("Recommended Next Steps for Districts & States", styles['H1']))
    next_steps = [
        "Clone the repository and stand up a lab environment using the USB build script",
        "Customize the six Ignition profiles for your specific policies and branding",
        "Evaluate the Quadlet container versions vs traditional systemd units",
        "Test air-gapped deployment workflow with your current network/security constraints",
        "Provide feedback on missing features or integration points with your existing SIS/LMS"
    ]
    for n in next_steps:
        story.append(Paragraph(f"• {n}", styles['EduExecBullet']))
    
    story.append(Spacer(1, 0.15*inch))
    story.append(Paragraph(
        "EduOS is open for contribution from school district IT teams, state education technology offices, and vendors who believe educational technology should be secure, maintainable, and respectful of student privacy.",
        styles['Body']
    ))
    
    story.append(Spacer(1, 0.2*inch))
    story.append(Paragraph("Full technical dossier (8 pages with diagrams) available in the repository.", styles['Body']))
    story.append(Paragraph("— The EduOS Project | eduos.local | June 2026", styles['Sub']))
    
    doc.build(story, onFirstPage=add_header_footer, onLaterPages=add_header_footer)
    print(f"Executive Summary generated: {OUTPUT}")

if __name__ == "__main__":
    build()
